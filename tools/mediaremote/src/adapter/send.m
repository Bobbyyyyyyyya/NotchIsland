// Copyright (c) 2025 Jonas van den Berg
// This file is licensed under the BSD 3-Clause License.

#include "private/MediaRemote.h"
#include <limits.h>

#import <Foundation/Foundation.h>

#import "MediaRemoteAdapter.h"
#import "adapter/env.h"
#import "adapter/globals.h"
#import "adapter/now_playing.h"
#import "utility/helpers.h"

static NSArray<NSNumber *> *acceptedCommands;

__attribute__((constructor)) static void init() {
    acceptedCommands = @[
        @(kMRAPlay),
        @(kMRAPause),
        @(kMRATogglePlayPause),
        @(kMRAStop),
        @(kMRANextTrack),
        @(kMRAPreviousTrack),
        @(kMRAToggleShuffle),
        @(kMRAToggleRepeat),
        @(kMRAStartForwardSeek),
        @(kMRAEndForwardSeek),
        @(kMRAStartBackwardSeek),
        @(kMRAEndBackwardSeek),
        @(kMRAGoBackFifteenSeconds),
        @(kMRASkipFifteenSeconds),
    ];
    // TODO like/unlike tracks by reading now playing information first,
    // getting the track ID, station ID and station hash
    // and then sending the respective MRCommand.
    // does "ban" mean "remove like" here?
}

static MRCommand findCommand(int command, bool *found) {
    if ([acceptedCommands containsObject:@(command)]) {
        *found = true;
        return (MRCommand)command;
    }
    *found = false;
    return (MRCommand)0;
}

@interface MRPlayerPathBuilder : NSObject
- (instancetype)initWithOrigin:(id)origin client:(id)client player:(id)player;
@end

@protocol MRClientBundle <NSObject>
- (NSString *)bundleIdentifier;
@end

static NSArray *nowPlayingClients(void) {
    if (!g_mediaRemote.getNowPlayingClients) {
        return @[];
    }
    __block id payload = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    g_mediaRemote.getNowPlayingClients(
        dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^(id clients) {
          payload = clients;
          dispatch_semaphore_signal(sem);
        });
    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(sem, timeout) != 0 || payload == nil) {
        return @[];
    }
    if ([payload isKindOfClass:[NSArray class]]) {
        return payload;
    }
    if ([payload isKindOfClass:[NSSet class]]) {
        return [(NSSet *)payload allObjects];
    }
    return @[payload];
}

/**
 * The command options that address one specific now playing client.
 *
 * Sending without them reaches whichever application MediaRemote has in front,
 * which on a machine that runs a browser next to a media player is usually the
 * browser, so the play button then does nothing while a song is audible.
 * Returns nil when the client is not registered, in which case the caller falls
 * back to the plain command.
 */
static NSDictionary *userInfoForBundle(NSString *bundle) {
    if (bundle.length == 0 || g_mediaRemote.getLocalOrigin == nil ||
        g_mediaRemote.addPlayerPathToUserInfo == nil) {
        return nil;
    }
    id origin = g_mediaRemote.getLocalOrigin();
    if (origin == nil) {
        return nil;
    }
    id target = nil;
    for (id client in nowPlayingClients()) {
        if (![client respondsToSelector:@selector(bundleIdentifier)]) {
            continue;
        }
        NSString *clientBundle = [(id<MRClientBundle>)client bundleIdentifier];
        if ([clientBundle isKindOfClass:[NSString class]] &&
            [clientBundle isEqualToString:bundle]) {
            target = client;
            break;
        }
    }
    if (target == nil) {
        return nil;
    }
    Class pathClass = NSClassFromString(@"MRPlayerPath");
    if (pathClass == Nil) {
        return nil;
    }
    MRPlayerPathBuilder *path = [(MRPlayerPathBuilder *)[pathClass alloc]
        initWithOrigin:origin
                client:target
                player:nil];
    if (path == nil) {
        return nil;
    }
    NSMutableDictionary *userInfo = [NSMutableDictionary dictionary];
    g_mediaRemote.addPlayerPathToUserInfo(userInfo, path);
    return userInfo.count > 0 ? userInfo : nil;
}

void adapter_send(MRACommand command) {

    bool ok = false;
    MRCommand commandValue = findCommand((int)command, &ok);
    if (!ok) {
        failf(@"Invalid command: %d", command);
    }

    bool result = false;
    NSString *bundle = getEnvFuncParam(@"adapter_send", 1, @"bundle");
    if (bundle.length > 0) {
        NSDictionary *userInfo = userInfoForBundle(bundle);
        if (userInfo != nil) {
            result = g_mediaRemote.sendCommand(commandValue, userInfo);
        }
    }
    if (!result) {
        result = g_mediaRemote.sendCommand(commandValue, nil);
    }
    if (!result) {
        failf(@"Failed to send command %d", command);
    }

    waitForCommandCompletion();
}

static inline int send_0_command() {
    return getEnvFuncParamIntSafe(@"adapter_send", 0, @"command");
}

void adapter_send_env() { adapter_send((MRACommand)send_0_command()); }
