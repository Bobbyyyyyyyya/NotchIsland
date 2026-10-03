// Copyright (c) 2025 Jonas van den Berg
// This file is licensed under the BSD 3-Clause License.

#import <AppKit/AppKit.h>
#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>

#import "MediaRemoteAdapter.h"
#import "adapter/elected.h"
#import "adapter/env.h"
#import "adapter/globals.h"
#import "adapter/keys.h"
#import "adapter/now_playing.h"
#import "private/MediaRemote.h"
#import "utility/Debounce.h"
#import "utility/helpers.h"

#ifndef DEBOUNCE_DELAY_MILLIS
#define DEBOUNCE_DELAY_MILLIS 0
#endif

static CFRunLoopRef g_runLoop = NULL;

static NSString *serializeData(NSDictionary *data, BOOL diff, BOOL pretty) {
    return serializeJsonDictionarySafe(
        @{
            @"type" : @"data",
            @"diff" : @(diff),
            @"payload" : data ?: @{},
        },
        pretty);
}

static NSDictionary *createDiff(NSDictionary *a, NSDictionary *b) {
    NSMutableDictionary *diff = [NSMutableDictionary dictionary];
    NSMutableSet *allKeys = [NSMutableSet setWithArray:a.allKeys];
    [allKeys addObjectsFromArray:b.allKeys];
    for (id key in allKeys) {
        id oldValue = a[key];
        id newValue = b[key];
        BOOL valuesDiffer = NO;
        if (oldValue == nil && newValue != nil) {
            valuesDiffer = YES;
        } else if (oldValue != nil && newValue == nil) {
            valuesDiffer = YES;
        } else if (![oldValue isEqual:newValue]) {
            valuesDiffer = YES;
        }
        if (valuesDiffer) {
            diff[key] = newValue ?: [NSNull null];
        }
    }
    return [diff copy];
}

static BOOL isSameItemIdentity(NSDictionary *a, NSDictionary *b) {
    NSArray<NSString *> *keys = identifyingPayloadKeys();
    for (NSString *key in keys) {
        id aValue = a[key];
        id bValue = b[key];
        if (aValue == nil && bValue == nil) {
            continue;
        }
        if (aValue == nil || bValue == nil) {
            return NO;
        }
        if (![aValue isEqual:bValue]) {
            return NO;
        }
    }
    return YES;
}

static NSDictionary *previousData = nil;

static void printData(NSDictionary *data, BOOL diff, BOOL pretty) {
    NSString *serialized = nil;
    if (diff && previousData != nil && isSameItemIdentity(previousData, data)) {
        NSDictionary *result = createDiff(previousData, data);
        if ([result count] == 0) {
            return;
        }
        serialized = serializeData(result, YES, pretty);
    } else {
        serialized = serializeData(data, NO, pretty);
    }
    if (serialized != nil) {
        if (diff) {
            previousData = [data copy];
        }
        // Print the serialized data without duplicates. Note that while this
        // can fail when the key order in the serialized JSON output changes,
        // it practically won't because if it did, there would also be a change
        // in values that needs to be reported.
        printOutUnique(serialized);
    }
    if (!diff) {
        previousData = nil;
    }
}

static void appForNotification(NSNotification *notification,
                               void (^block)(NSRunningApplication *)) {
    NSDictionary *userInfo = notification.userInfo;
    id pidValue = userInfo[kMRMediaRemoteNowPlayingApplicationPIDUserInfoKey];
    if (pidValue != nil) {
        int pid = [pidValue intValue];
        appForPID(pid, block);
    } else {
        block(nil);
    }
};

typedef struct MetadataStats {
    BOOL trackTitleChanged;
    int identifyingTrackKeysIdentical;
    int identifyingTrackKeysChanged;
} MetadataStats;

static MetadataStats createMetadataStats() {
    MetadataStats stats = {
        .trackTitleChanged = NO,
        .identifyingTrackKeysIdentical = 0,
        .identifyingTrackKeysChanged = 0,
    };
    return stats;
}

static MetadataStats compareIdentifyingTrackKeys(NSDictionary *prev,
                                                 NSDictionary *next) {
    MetadataStats stats = createMetadataStats();
    for (NSString *key in @[ kMRATitle, kMRAArtist, kMRAAlbum ]) {
        id a = prev[key], b = next[key];
        if (a == nil || b == nil)
            continue;
        if ([a isEqual:b]) {
            stats.identifyingTrackKeysIdentical++;
        } else {
            stats.identifyingTrackKeysChanged++;
            if ([key isEqualToString:kMRATitle]) {
                stats.trackTitleChanged = YES;
            }
        }
    }
    return stats;
}

extern void adapter_stream() {

    // Get ADAPTER_TEST_MODE as a boolean and set BOOL isTestMode
    BOOL isTestMode = NO;
    char *testModeEnv = getenv("ADAPTER_TEST_MODE");
    if (testModeEnv && strcmp(testModeEnv, "0") != 0 &&
        strlen(testModeEnv) > 0) {
        isTestMode = YES;
    }

    int debounce_delay_millis = 0;
    NSNumber *debounce_option = getEnvOptionInt(@"debounce");
    if (debounce_option != nil) {
        debounce_delay_millis = [debounce_option intValue];
    }

    NSString *no_diff_option = getEnvOption(@"no_diff");
    NSString *no_artwork_option = getEnvOption(@"no-artwork");
    NSString *micros_option = getEnvOption(@"micros");
    NSString *human_readable_option = getEnvOption(@"human-readable");
    NSString *allow_missing_title_option =
        getEnvOption(@"allow-missing-title");

    // This option is needed for media players which, when changing tracks,
    // update the artist and/or other fields later than e.g. the title, the
    // invalid in-between metadata therefore representing "peculiar" media. The
    // only known player that does this is the TIDAL desktop player with the
    // bundle ID "com.tidal.desktop". This is easy to reproduce when playing
    // media from a playlist with tracks from different artists.
    // FIXME Implement this for any bundle ID, should other players need it.
    // In that case parse any "experimental-peculiar-debounce:*" option.
    NSNumber *peculiar_debounce_option =
        getEnvOptionInt(@"experimental-peculiar-debounce:com.tidal.desktop");
    __block NSString *peculiar_bundle_id = nil;
    __block Debounce *peculiar_debounce = nil;
    __block BOOL did_peculiar_debounce = NO;
    if (peculiar_debounce_option != nil) {
        peculiar_bundle_id = @"com.tidal.desktop";
        int debounce_millis = [peculiar_debounce_option intValue];
        peculiar_debounce =
            [[Debounce alloc] initWithDelay:(debounce_millis / 1000.0)
                                      queue:g_serialdispatchQueue];
    }

    __block NSMutableDictionary *liveData = [NSMutableDictionary dictionary];
    __block MetadataStats liveDataStats = createMetadataStats();
    __block const Debounce *const debounce =
        [[Debounce alloc] initWithDelay:(debounce_delay_millis / 1000.0)
                                  queue:g_serialdispatchQueue];
    __block const BOOL no_diff = (no_diff_option != nil);
    __block const BOOL no_artwork = (no_artwork_option != nil);
    __block const BOOL convert_micros = (micros_option != nil);
    __block const bool human_readable = (human_readable_option != nil);
    // Players that hand MediaRemote an empty metadata dictionary (untagged
    // audio, e.g. a file shared in a chat client) still register a now playing
    // client with a PID and a playback state. Without this option such a
    // session is indistinguishable from "nothing is playing", even though
    // Control Center shows it, using the application name as the label.
    __block const bool allow_missing_title = (allow_missing_title_option != nil);

    void (^localPrintData)(NSDictionary *) = ^(NSDictionary *data) {
      printData(data, !no_diff, human_readable);
    };

    void (^directHandle)() = ^() {
      if (allMandatoryPayloadKeysSet(liveData, allow_missing_title)) {
          if (human_readable) {
              NSMutableDictionary *shallowClone =
                  [NSMutableDictionary dictionaryWithDictionary:liveData];
              makePayloadHumanReadable(shallowClone);
              localPrintData(shallowClone);
          } else {
              localPrintData(liveData);
          }
      } else {
          localPrintData(nil);
      }
    };

    void (^internalHandle)(bool) = ^(bool updatedStats) {
      if (peculiar_debounce == nil ||
          ![peculiar_bundle_id isEqual:liveData[kMRABundleIdentifier]]) {
          directHandle();
          return;
      }
      if (updatedStats && liveDataStats.trackTitleChanged &&
          liveDataStats.identifyingTrackKeysIdentical > 0) {
          did_peculiar_debounce = true;
          [peculiar_debounce call:^{
            did_peculiar_debounce = false;
            directHandle();
          }];
      } else if (did_peculiar_debounce &&
                 (!updatedStats ||
                  liveDataStats.identifyingTrackKeysChanged == 0)) {
          // Ignore this handle call, since there is an active debounce call.
      } else {
          [peculiar_debounce cancel];
          did_peculiar_debounce = false;
          directHandle();
      }
    };

    void (^handle)() = ^() {
      internalHandle(false);
    };

    void (^handleWithUpdatedStats)() = ^() {
      internalHandle(true);
    };

    void (^requestNowPlayingApplicationPID)() = ^{
      g_mediaRemote.getNowPlayingApplicationPID(
          g_serialdispatchQueue, ^(int pid) {
            if (pid == 0) {
                liveData[kMRAProcessIdentifier] = nil;
                handle();
                return;
            }
            liveData[kMRAProcessIdentifier] = @(pid);
            bool ok = appForPID(pid, ^(NSRunningApplication *process) {
              if (process.bundleIdentifier != nil) {
                  liveData[kMRABundleIdentifier] = process.bundleIdentifier;
              }
              handle();
            });
            if (!ok) {
                handle();
            }
          });
    };

    void (^requestNowPlayingParentApplicationBundleIdentifier)() = ^{
      g_mediaRemote.getNowPlayingClient(g_serialdispatchQueue, ^(id client) {
        NSString *parentAppBundleID = nil;
        if (client && [client respondsToSelector:@selector
                              (parentApplicationBundleIdentifier)]) {
            id result = [client
                performSelector:@selector(parentApplicationBundleIdentifier)];
            if ([result isKindOfClass:[NSString class]]) {
                parentAppBundleID = result;
            }
        }
        if (parentAppBundleID) {
            liveData[kMRAParentApplicationBundleIdentifier] = parentAppBundleID;
        } else {
            [liveData removeObjectForKey:kMRAParentApplicationBundleIdentifier];
        }
        handle();
      });
    };

    void (^requestNowPlayingApplicationIsPlaying)() = ^{
      g_mediaRemote.getNowPlayingApplicationIsPlaying(
          g_serialdispatchQueue, ^(bool isPlaying) {
            liveData[kMRAPlaying] = @(isPlaying);
            handle();
          });
    };

    void (^requestNowPlayingInfo)() = ^{
      g_mediaRemote.getNowPlayingInfo(g_serialdispatchQueue, ^(
                                          NSDictionary *information) {
        NSString *serviceIdentifier =
            information[kMRMediaRemoteNowPlayingInfoServiceIdentifier];
        if (!isTestMode &&
            [serviceIdentifier
                isEqualToString:
                    @"com.vandenbe.MediaRemoteAdapter.TestClient"]) {
            return;
        }
        NSMutableDictionary *converted = convertNowPlayingInformation(
            information, convert_micros, false, no_artwork);
        // Transfer anything over from the existing live data.
        if (liveData[kMRAProcessIdentifier] != nil) {
            converted[kMRAProcessIdentifier] = liveData[kMRAProcessIdentifier];
        }
        if (liveData[kMRABundleIdentifier] != nil) {
            converted[kMRABundleIdentifier] = liveData[kMRABundleIdentifier];
        }
        if (liveData[kMRAParentApplicationBundleIdentifier] != nil) {
            converted[kMRAParentApplicationBundleIdentifier] =
                liveData[kMRAParentApplicationBundleIdentifier];
        }
        if (liveData[kMRAPlaying] != nil) {
            converted[kMRAPlaying] = liveData[kMRAPlaying];
        }
        // Use the old artwork data, since often the MediaRemote framework
        // unloads the artwork and then loads it again shortly after.
        // Only do this when the items have the same identity.
        if (isSameItemIdentity(liveData, converted) &&
            liveData[kMRAArtworkData] != nil &&
            liveData[kMRAArtworkData] != [NSNull null] &&
            converted[kMRAArtworkData] == nil) {
            converted[kMRAArtworkData] = liveData[kMRAArtworkData];
            if (liveData[kMRAArtworkMimeType] != nil &&
                liveData[kMRAArtworkMimeType] != [NSNull null] &&
                converted[kMRAArtworkMimeType] == nil) {
                converted[kMRAArtworkMimeType] = liveData[kMRAArtworkMimeType];
            }
        }

        liveDataStats = compareIdentifyingTrackKeys(liveData, converted);
        [liveData setDictionary:converted];
        handleWithUpdatedStats();
      });
    };

    void (^resetAll)() = ^{
      [liveData removeAllObjects];
    };

    void (^requestFrontApplication)() = ^{
      requestNowPlayingApplicationPID();
      requestNowPlayingParentApplicationBundleIdentifier();
      requestNowPlayingApplicationIsPlaying();
      requestNowPlayingInfo();
    };

    // MediaRemote reports the application it has in front, which is the one
    // that registered last rather than the one that is actually playing. On a
    // Mac that runs a browser next to a media player the browser steals the
    // slot for minutes at a time, so resolve an explicit client instead and
    // only fall back to the front application when no client can be elected.
    // Bumped by every election so that a slow one can be discarded when a
    // newer one, for example from the poll timer, has already started.
    __block NSUInteger electionSequence = 0;
    // Missed elections in a row; see the fallback below.
    __block NSUInteger electionMisses = 0;

    void (^requestElected)() = ^{
      NSUInteger sequence = ++electionSequence;
      NSString *incumbentBundle = [liveData[kMRABundleIdentifier] isKindOfClass:[NSString class]]
                                      ? liveData[kMRABundleIdentifier]
                                      : nil;
      NSString *incumbentParent =
          [liveData[kMRAParentApplicationBundleIdentifier] isKindOfClass:[NSString class]]
              ? liveData[kMRAParentApplicationBundleIdentifier]
              : nil;
      MRAResolveNowPlaying(!isTestMode, !allow_missing_title, incumbentBundle, incumbentParent,
                           ^(NSDictionary *resolved) {
        if (sequence != electionSequence) {
            return;
        }
        if (resolved == nil || [resolved[@"processIdentifier"] intValue] <= 0) {
            // An election that comes back empty is a hiccup, not silence: the
            // front application MediaRemote hands out at that moment is rarely
            // the one making sound, and publishing it folded the player while
            // the sound kept going. Keep what is on screen and let the next
            // poll settle it, and only give up after several misses so a track
            // that really ended still folds away.
            static const int kElectionMissLimit = 3;
            // Only while an election is actually running: with the election
            // switched off, as the adapter's own test mode does, every round
            // comes back empty and holding the screen would freeze it.
            if (!isTestMode && liveData[kMRATitle] != nil &&
                ++electionMisses < kElectionMissLimit) {
                return;
            }
            electionMisses = 0;
            resetAll();
            requestFrontApplication();
            return;
        }
        electionMisses = 0;

        NSMutableDictionary *converted = [NSMutableDictionary dictionary];
        converted[kMRAProcessIdentifier] = resolved[@"processIdentifier"];
        id bundleIdentifier = resolved[@"bundleIdentifier"];
        if ([bundleIdentifier isKindOfClass:[NSString class]]) {
            converted[kMRABundleIdentifier] = bundleIdentifier;
        }
        id parentBundleIdentifier = resolved[@"parentApplicationBundleIdentifier"];
        if ([parentBundleIdentifier isKindOfClass:[NSString class]]) {
            converted[kMRAParentApplicationBundleIdentifier] = parentBundleIdentifier;
        }
        converted[kMRAPlaying] = resolved[@"playing"];

        NSDictionary *information = [resolved[@"info"] isKindOfClass:[NSDictionary class]]
                                        ? resolved[@"info"]
                                        : nil;
        NSString *serviceIdentifier =
            information[kMRMediaRemoteNowPlayingInfoServiceIdentifier];
        if (!isTestMode &&
            [serviceIdentifier
                isEqualToString:@"com.vandenbe.MediaRemoteAdapter.TestClient"]) {
            return;
        }
        [converted
            addEntriesFromDictionary:convertNowPlayingInformation(
                                      information, convert_micros, false, no_artwork)];

        // Use the old artwork data, since often the MediaRemote framework
        // unloads the artwork and then loads it again shortly after.
        // Only do this when the items have the same identity.
        if (isSameItemIdentity(liveData, converted) && liveData[kMRAArtworkData] != nil &&
            liveData[kMRAArtworkData] != [NSNull null] && converted[kMRAArtworkData] == nil) {
            converted[kMRAArtworkData] = liveData[kMRAArtworkData];
            if (liveData[kMRAArtworkMimeType] != nil &&
                liveData[kMRAArtworkMimeType] != [NSNull null] &&
                converted[kMRAArtworkMimeType] == nil) {
                converted[kMRAArtworkMimeType] = liveData[kMRAArtworkMimeType];
            }
        }

        // No "stopped" frame in between: one application handing the screen to
        // another published a stopped state first, and that single frame folded
        // the player and opened it again for a sound that never stopped. The
        // election is polled now, so a client that really went quiet is caught
        // by the next resolution instead.
        liveDataStats = compareIdentifyingTrackKeys(liveData, converted);
        [liveData setDictionary:converted];
        handleWithUpdatedStats();
      });
    };

    void (^requestAll)() = ^{
      requestElected();
    };

    void (^refreshAll)() = ^{
      resetAll();
      requestAll();
    };

    // FIXME Is this foolproof? This continues and registers observers
    // which might intervene with the initial requests.
    requestAll();

    NSNotificationCenter *default_center = [NSNotificationCenter defaultCenter];
    NSNotificationCenter *shared_workscape_notification_center =
        [[NSWorkspace sharedWorkspace] notificationCenter];

    // TODO Refactor the below two callbacks. They share a lot of code.

    // Both observers re-elect the now playing client. The notification itself
    // only describes the application MediaRemote has in front, which is not
    // necessarily the application that is playing.
    id is_playing_change_observer = [default_center
        addObserverForName:
            kMRMediaRemoteNowPlayingApplicationIsPlayingDidChangeNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification *notification) {
                  dispatch_async(g_serialdispatchQueue, ^() {
                    requestElected();
                  });
                }];

    id info_change_observer = [default_center
        addObserverForName:kMRMediaRemoteNowPlayingInfoDidChangeNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification *notification) {
                  [debounce call:^{
                    dispatch_async(g_serialdispatchQueue, ^() {
                      requestElected();
                    });
                  }];
                }];

    // Register notifications for when applications are closed.
    id app_termination_observer = [shared_workscape_notification_center
        addObserverForName:NSWorkspaceDidTerminateApplicationNotification
                    object:nil
                     queue:nil
                usingBlock:^(NSNotification *notification) {
                  dispatch_async(g_serialdispatchQueue, ^() {
                    NSDictionary *userInfo = [notification userInfo];
                    id bundleIdentifier =
                        userInfo[@"NSApplicationBundleIdentifier"];
                    if (bundleIdentifier != nil &&
                        [bundleIdentifier
                            isEqual:liveData[kMRABundleIdentifier]]) {
                        // Refresh all data, since the application terminated.
                        refreshAll();
                    }
                  });
                }];

    g_mediaRemote.registerForNowPlayingNotifications(g_serialdispatchQueue);

    // MediaRemote does not always notify when the application it has in front
    // stops, and it says nothing about a client that only starts playing in the
    // background while another application holds the slot. Polling keeps the
    // elected client honest. Payloads that did not change are dropped by
    // printData, so a system where nothing happens stays completely silent.
    dispatch_source_t election_timer = NULL;
    if (!isTestMode) {
        election_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                                 g_serialdispatchQueue);
        dispatch_source_set_timer(election_timer,
                                  dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2 * NSEC_PER_SEC)),
                                  (uint64_t)(2 * NSEC_PER_SEC), (uint64_t)(500 * NSEC_PER_MSEC));
        dispatch_source_set_event_handler(election_timer, ^{
          requestElected();
        });
        dispatch_resume(election_timer);
    }

    CFRunLoopRun();

    if (election_timer != NULL) {
        dispatch_source_cancel(election_timer);
    }

    g_mediaRemote.unregisterForNowPlayingNotifications();

    [default_center removeObserver:is_playing_change_observer];
    [default_center removeObserver:info_change_observer];
    [shared_workscape_notification_center
        removeObserver:app_termination_observer];
}

extern void adapter_stream_env() { adapter_stream(); }

extern void _adapter_stream_cancel() {
    if (g_runLoop) {
        CFRunLoopStop(g_runLoop);
    }
}

static void handleSignal(int signal) {
    if (signal == SIGINT || signal == SIGTERM) {
        _adapter_stream_cancel();
    }
}

__attribute__((constructor)) static void init() {
    g_runLoop = CFRunLoopGetCurrent();
    signal(SIGINT, handleSignal);
    signal(SIGTERM, handleSignal);
}
__attribute__((destructor)) static void teardown() { _adapter_stream_cancel(); }

// FIXME Fix "peculiar media" (artist is updated later than title). Example:
/*
35.558 Thirteen by Big Star on Camping Songs
36.091 Good Vibrations (Remastered 2001) by Big Star on Camping Songs
36.204 Good Vibrations (Remastered 2001) by Big Star on Camping Songs (+image)
36.624 Good Vibrations (Remastered 2001) by The Beach Boys on Camping Songs
*/
