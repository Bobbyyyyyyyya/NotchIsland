// Copyright (c) 2025 Jonas van den Berg
// This file is licensed under the BSD 3-Clause License.

#include <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <objc/runtime.h>

#import "MediaRemoteAdapter.h"
#import "adapter/elected.h"
#import "adapter/globals.h"
#import "adapter/keys.h"
#import "adapter/now_playing.h"
#import "private/MediaRemote.h"
#import "utility/helpers.h"

// MRPlaybackState as reported by MRMediaRemoteGetPlaybackStateForClient.
static const int kMRPlaybackStateStopped = 0;
static const int kMRPlaybackStatePlaying = 1;
static const int kMRPlaybackStatePaused = 2;

// A single client resolution must finish within this window, otherwise one
// unresponsive client would stall the whole election.
static const double kClientTimeoutSeconds = 3.0;

static NSSet<NSString *> *knownMediaBundles(void) {
    static NSSet<NSString *> *bundles;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
      bundles = [NSSet setWithArray:@[
          @"com.apple.Music",
          @"com.apple.TVMusic",
          @"com.apple.iTunes",
          @"com.apple.podcasts",
          @"com.apple.TV",
          @"com.spotify.Spotify",
          @"com.apple.MusicXMR",
          @"org.videolan.vlc",
          @"com.videolan.vlc",
          @"com.audacious.audacious",
          @"org.clementine-player.Clementine",
          @"com.hm.outrun",
          @"com.apple.iBooksX",
          @"com.apple.iMovieApp",
      ]];
    });
    return bundles;
}

static NSSet<NSString *> *browserBundles(void) {
    static NSSet<NSString *> *bundles;
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
      bundles = [NSSet setWithArray:@[
          @"com.apple.Safari",
          @"com.apple.SafariTechnologyPreview",
          @"com.google.Chrome",
          @"com.microsoft.edgemac",
          @"org.chromium.Chromium",
          @"com.brave.Browser",
          @"com.mozilla.firefox",
          @"com.operasoftware.Opera",
          @"company.thebrowser.Browser",
          @"com.duckduckgo.macos.browser",
          @"com.Electron",
      ]];
    });
    return bundles;
}

static id invokeReturningId(id object, SEL selector) {
    if (object == nil || ![object respondsToSelector:selector]) return nil;
    NSMethodSignature *signature = [object methodSignatureForSelector:selector];
    if (signature == nil) return nil;
    if (signature.methodReturnType == NULL || signature.methodReturnType[0] != '@') return nil;
    IMP imp = [object methodForSelector:selector];
    return ((id (*)(id, SEL))imp)(object, selector);
}

static int invokeReturningInt(id object, SEL selector) {
    if (object == nil || ![object respondsToSelector:selector]) return 0;
    NSMethodSignature *signature = [object methodSignatureForSelector:selector];
    if (signature == nil) return 0;
    char type = signature.methodReturnType != NULL ? signature.methodReturnType[0] : '\0';
    IMP imp = [object methodForSelector:selector];
    switch (type) {
        case 'i': return ((int (*)(id, SEL))imp)(object, selector);
        case 's': return ((short (*)(id, SEL))imp)(object, selector);
        case 'c': return ((char (*)(id, SEL))imp)(object, selector);
        case 'q':
        case 'l': return (int)((long long (*)(id, SEL))imp)(object, selector);
        default: return 0;
    }
}

static NSString *stringProperty(id object, SEL selector) {
    id value = invokeReturningId(object, selector);
    return [value isKindOfClass:[NSString class]] ? value : nil;
}

static NSArray *clientArray(id payload) {
    if (payload == nil) return @[];
    if ([payload isKindOfClass:[NSArray class]]) return payload;
    if ([payload isKindOfClass:[NSSet class]]) return [(NSSet *)payload allObjects];
    if ([payload isKindOfClass:[NSDictionary class]]) return [(NSDictionary *)payload allValues];
    return @[ payload ];
}

static id firstPlayer(id payload) {
    NSArray *players = clientArray(payload);
    for (id player in players) {
        if (player != nil && player != [NSNull null]) return player;
    }
    return nil;
}

static BOOL hasTitle(NSDictionary *info) {
    id title = info[kMRMediaRemoteNowPlayingInfoTitle];
    return [title isKindOfClass:[NSString class]] && [(NSString *)title length] > 0;
}

// MediaRemote empties a client's info dictionary while it reloads one, and
// every such round scored the client as if it had gone silent: the election
// then handed the screen to whichever neighbour still had a title, and gave it
// straight back a round later. One sound traded places over and over, folding
// the player each time. Keep the last titled info per process for a moment and
// fill the hole with it; the playback state always comes from the live round.
static const double kInfoCacheSeconds = 10.0;
static NSMutableDictionary<NSNumber *, NSDictionary *> *cachedInfo = nil;
static NSMutableDictionary<NSNumber *, NSDate *> *cachedInfoAt = nil;

static NSDictionary *reconcileInfo(int pid, NSDictionary *info) {
    if (pid <= 0) return info;
    if (cachedInfo == nil) {
        cachedInfo = [NSMutableDictionary dictionary];
        cachedInfoAt = [NSMutableDictionary dictionary];
    }
    NSNumber *key = @(pid);
    NSDate *now = [NSDate date];
    if (hasTitle(info)) {
        cachedInfo[key] = info;
        cachedInfoAt[key] = now;
        return info;
    }
    NSDate *at = cachedInfoAt[key];
    NSDictionary *known = cachedInfo[key];
    if (known == nil || at == nil || [now timeIntervalSinceDate:at] > kInfoCacheSeconds) {
        return info;
    }
    NSMutableDictionary *merged = [NSMutableDictionary dictionaryWithDictionary:known];
    for (id cachedKey in info) {
        id value = info[cachedKey];
        if (value != nil && value != [NSNull null]) merged[cachedKey] = value;
    }
    return merged;
}

// What the client already on screen gets for staying a candidate. Only the
// tie breaker: two clients reporting the same sound score identically, and
// without an edge for the one on screen they trade places whenever MediaRemote
// hands them back in a different order, which is what folded the player over
// and over for one sound. Kept small so a player that really starts still
// overtakes a page that keeps playing.
static const int kIncumbentBonus = 50;
// The same edge for a second process of the application already on screen, for
// example the WebKit process that carries a browser tab's audio.
static const int kIncumbentSiblingBonus = 25;

static NSString *entryString(NSDictionary *entry, NSString *key) {
    id value = entry[key];
    return [value isKindOfClass:[NSString class]] ? value : nil;
}

// True when an entry describes the same application as the client on screen,
// either directly or through its parent: Safari and the WebKit process that
// renders its audio are one application, and so are a browser and its helper.
static bool sameApplication(NSDictionary *entry, NSString *incumbentBundle,
                            NSString *incumbentParent) {
    if (incumbentBundle == nil && incumbentParent == nil) return false;
    NSString *bundle = entryString(entry, @"bundleIdentifier");
    NSString *parent = entryString(entry, @"parentApplicationBundleIdentifier");
    if (bundle == nil && parent == nil) return false;
    if (incumbentBundle != nil &&
        ([incumbentBundle isEqualToString:bundle] ||
         [incumbentBundle isEqualToString:parent])) {
        return true;
    }
    if (incumbentParent != nil &&
        ([incumbentParent isEqualToString:bundle] ||
         [incumbentParent isEqualToString:parent])) {
        return true;
    }
    return false;
}

static int scoreEntry(NSDictionary *entry, bool requireTitle, NSString *incumbentBundle,
                      NSString *incumbentParent) {
    NSDictionary *info = entry[@"info"];
    if (![info isKindOfClass:[NSDictionary class]]) info = nil;
    if (requireTitle && !hasTitle(info)) return -1;

    NSString *bundle = entry[@"bundleIdentifier"];
    if (![bundle isKindOfClass:[NSString class]]) bundle = nil;
    int state = [entry[@"state"] intValue];

    int score = 0;
    if (state == kMRPlaybackStatePlaying) {
        score += 1000;
    } else if (state == kMRPlaybackStatePaused) {
        score += 500;
    }
    if (hasTitle(info)) score += 200;
    if ([info[kMRMediaRemoteNowPlayingInfoIsMusicApp] boolValue]) score += 100;
    if (bundle != nil && [knownMediaBundles() containsObject:bundle]) score += 80;
    id contentType = info[@"kMRMediaRemoteNowPlayingInfoStrictMediaType"];
    if ([contentType isKindOfClass:[NSString class]] &&
        [(NSString *)contentType isEqualToString:@"audio"]) {
        score += 20;
    }
    if (bundle != nil) {
        if ([browserBundles() containsObject:bundle]) score -= 60;
        if ([bundle hasPrefix:@"com.apple.WebKit"]) score -= 60;
    }
    if (state == kMRPlaybackStatePlaying) {
        if (bundle != nil && incumbentBundle != nil && [bundle isEqualToString:incumbentBundle]) {
            score += kIncumbentBonus;
        } else if (sameApplication(entry, incumbentBundle, incumbentParent)) {
            score += kIncumbentSiblingBonus;
        }
    }
    return score;
}

static NSDictionary *pickBest(NSArray<NSDictionary *> *entries, bool requireTitle,
                              NSString *incumbentBundle, NSString *incumbentParent) {
    NSDictionary *best = nil;
    int bestScore = -1;
    for (NSDictionary *entry in entries) {
        int score = scoreEntry(entry, requireTitle, incumbentBundle, incumbentParent);
        if (score > bestScore) {
            bestScore = score;
            best = entry;
        }
    }
    return bestScore >= 0 ? best : nil;
}

static void collectClient(id client, id origin, bool requireTitle,
                          void (^completion)(NSDictionary *entry)) {
    NSString *bundle = stringProperty(client, @selector(bundleIdentifier));
    NSString *parentBundle =
        stringProperty(client, @selector(parentApplicationBundleIdentifier));
    int pid = invokeReturningInt(client, @selector(processIdentifier));

    __block BOOL finished = NO;
    void (^finish)(NSDictionary *) = ^(NSDictionary *entry) {
      if (finished) return;
      finished = YES;
      completion(entry);
    };

    dispatch_after(
        dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kClientTimeoutSeconds * NSEC_PER_SEC)),
        g_serialdispatchQueue, ^{
          finish(nil);
        });

    g_mediaRemote.getPlaybackStateForClient(client, origin, g_serialdispatchQueue, ^(int state) {
      g_mediaRemote.getPlayersForClient(client, origin, g_serialdispatchQueue, ^(id players) {
        id player = firstPlayer(players);
        if (player == nil) {
            finish(nil);
            return;
        }
        g_mediaRemote.getNowPlayingInfoForClient(
            client, origin, player, g_serialdispatchQueue, ^(NSDictionary *info) {
              NSDictionary *resolvedInfo =
                  [info isKindOfClass:[NSDictionary class]] ? reconcileInfo(pid, info) : @{};
              finish(@{
                  @"info" : resolvedInfo,
                  @"processIdentifier" : @(pid),
                  @"bundleIdentifier" : bundle ?: [NSNull null],
                  @"parentApplicationBundleIdentifier" : parentBundle ?: [NSNull null],
                  @"playing" : @(state == kMRPlaybackStatePlaying),
                  @"state" : @(state),
              });
            });
      });
    });
}

// MediaRemote loads artwork only for the application it has in front, so the
// artwork of a chosen client is taken from the front application's payload
// whenever both describe the same application.
static NSDictionary *mergeArtwork(NSDictionary *chosen, NSDictionary *frontInfo,
                                  NSString *frontBundle) {
    if (![chosen[@"info"] isKindOfClass:[NSDictionary class]]) return chosen;
    NSString *bundle = chosen[@"bundleIdentifier"];
    if (![bundle isKindOfClass:[NSString class]] || frontInfo == nil ||
        ![frontBundle isKindOfClass:[NSString class]] ||
        ![bundle isEqualToString:frontBundle]) {
        return chosen;
    }
    if (chosen[@"info"][kMRMediaRemoteNowPlayingInfoArtworkData] != nil &&
        chosen[@"info"][kMRMediaRemoteNowPlayingInfoArtworkMIMEType] != nil) {
        return chosen;
    }
    id artwork = frontInfo[kMRMediaRemoteNowPlayingInfoArtworkData];
    id mimeType = frontInfo[kMRMediaRemoteNowPlayingInfoArtworkMIMEType];
    if (artwork == nil) return chosen;
    NSMutableDictionary *info = [NSMutableDictionary dictionaryWithDictionary:chosen[@"info"]];
    info[kMRMediaRemoteNowPlayingInfoArtworkData] = artwork;
    if (mimeType != nil) {
        info[kMRMediaRemoteNowPlayingInfoArtworkMIMEType] = mimeType;
    }
    NSMutableDictionary *merged = [NSMutableDictionary dictionaryWithDictionary:chosen];
    merged[@"info"] = info;
    return merged;
}

void MRAResolveNowPlaying(bool enabled, bool requireTitle, NSString *incumbentBundle,
                          NSString *incumbentParent,
                          void (^completion)(NSDictionary *resolved)) {
    MediaRemote *mediaRemote = g_mediaRemote;
    if (!enabled || mediaRemote == nil || mediaRemote.getNowPlayingClients == NULL ||
        mediaRemote.getLocalOrigin == NULL || mediaRemote.getPlaybackStateForClient == NULL ||
        mediaRemote.getPlayersForClient == NULL || mediaRemote.getNowPlayingInfoForClient == NULL) {
        completion(nil);
        return;
    }

    dispatch_group_t group = dispatch_group_create();
    __block id clientsPayload = nil;
    __block id origin = nil;
    __block NSDictionary *frontInfo = nil;
    __block NSString *frontBundle = nil;

    dispatch_group_enter(group);
    mediaRemote.getNowPlayingClients(g_serialdispatchQueue, ^(id payload) {
      clientsPayload = payload;
      dispatch_group_leave(group);
    });

    dispatch_group_enter(group);
    mediaRemote.getNowPlayingInfo(g_serialdispatchQueue, ^(NSDictionary *information) {
      frontInfo = [information isKindOfClass:[NSDictionary class]] ? information : nil;
      dispatch_group_leave(group);
    });

    dispatch_group_enter(group);
    mediaRemote.getNowPlayingClient(g_serialdispatchQueue, ^(id client) {
      frontBundle = stringProperty(client, @selector(bundleIdentifier));
      dispatch_group_leave(group);
    });

    dispatch_group_notify(group, g_serialdispatchQueue, ^{
      origin = mediaRemote.getLocalOrigin();
      NSArray *clients = clientArray(clientsPayload);
      if (origin == nil || clients.count == 0) {
          completion(nil);
          return;
      }

      NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
      dispatch_group_t clientGroup = dispatch_group_create();
      for (id client in clients) {
          dispatch_group_enter(clientGroup);
          collectClient(client, origin, requireTitle, ^(NSDictionary *entry) {
            if (entry != nil) [entries addObject:entry];
            dispatch_group_leave(clientGroup);
          });
      }

      dispatch_group_notify(clientGroup, dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT,
                                                                   0), ^{
        NSDictionary *best = pickBest(entries, requireTitle, incumbentBundle, incumbentParent);
        if (best == nil && requireTitle) {
            // Nothing reported a title. A web page playing sound rarely does,
            // so elect the loudest client anyway instead of handing the screen
            // back to the front application, which made the player blink while
            // the sound kept going.
            best = pickBest(entries, false, incumbentBundle, incumbentParent);
        }
        dispatch_async(g_serialdispatchQueue, ^{
          completion(best != nil ? mergeArtwork(best, frontInfo, frontBundle) : nil);
        });
      });
    });
}
