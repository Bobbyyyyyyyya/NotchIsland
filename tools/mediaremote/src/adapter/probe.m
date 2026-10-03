// Copyright (c) 2025 Jonas van den Berg
// This file is licensed under the BSD 3-Clause License.

// Diagnostic only: find out whether MediaRemote hands out now playing
// information *per client*, so the island can show the application that is
// actually playing instead of the one that last registered. Every signature
// variant is selected with PROBE_MODE and has to run in its own process,
// because a wrong argument order crashes. Invoked through the `probe`
// command in the vendored script.

#include <Foundation/Foundation.h>
#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <objc/objc.h>
#include <objc/runtime.h>
#include <objc/message.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#import "utility/helpers.h"

typedef void (^IdCompletion)(id value);
typedef void (^IntCompletion)(int value);
typedef void (*QueueIdBlock_t)(dispatch_queue_t, id, IdCompletion);
typedef void (*IdQueueBlock_t)(id, dispatch_queue_t, IdCompletion);
typedef void (*QueueIdIntBlock_t)(dispatch_queue_t, id, IntCompletion);
typedef void (*IdQueueIntBlock_t)(id, dispatch_queue_t, IntCompletion);
typedef void (*QueueStrBlock_t)(dispatch_queue_t, NSString *, IdCompletion);
typedef void (*QueueBlock_t)(dispatch_queue_t, IdCompletion);
typedef void (*IdQueueBlock2_t)(id, dispatch_queue_t, IdCompletion);

static void printInfo(id info) {
    if (!info) {
        printf("    info: nil\n");
        fflush(stdout);
        return;
    }
    if (![info isKindOfClass:[NSDictionary class]]) {
        printf("    info: <%s> %s\n", class_getName(object_getClass(info)),
               [[info description] UTF8String] ?: "");
        fflush(stdout);
        return;
    }
    NSDictionary *dict = info;
    printf("    info keys=%lu\n", (unsigned long)dict.count);
    NSArray *keys = [[dict allKeys] sortedArrayUsingSelector:@selector(compare:)];
    for (NSString *key in keys) {
        id value = dict[key];
        if (!value || value == [NSNull null]) {
            printf("      %s = (null)\n", key.UTF8String);
            continue;
        }
        if ([value isKindOfClass:[NSString class]]) {
            NSString *string = value;
            if (string.length > 90) string = [[string substringToIndex:90] stringByAppendingString:@"…"];
            printf("      %s = %s\n", key.UTF8String, string.UTF8String);
        } else if ([value isKindOfClass:[NSNumber class]]) {
            printf("      %s = %s\n", key.UTF8String, [[value stringValue] UTF8String]);
        } else {
            NSUInteger length = [value respondsToSelector:@selector(length)] ? [value length] : 0;
            printf("      %s = <%s> len=%lu\n", key.UTF8String,
                   class_getName(object_getClass(value)), (unsigned long)length);
        }
    }
    fflush(stdout);
}

static NSString *clientBundle(id client) {
    if (!client) return @"(nil)";
    SEL sel = @selector(bundleIdentifier);
    if (![client respondsToSelector:sel]) return @"(geen bundleIdentifier)";
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    id value = [client performSelector:sel];
#pragma clang diagnostic pop
    return [value isKindOfClass:[NSString class]] ? value : @"(geen string)";
}

static NSArray *collectClients(void *mediaRemote) {
    void *symbol = dlsym(mediaRemote, "MRMediaRemoteGetNowPlayingClients");
    if (!symbol) {
        printErrf(@"MRMediaRemoteGetNowPlayingClients is not exported");
        return @[];
    }
    __block id payload = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    ((void (*)(dispatch_queue_t, IdCompletion))symbol)(
        dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^(id clients) {
          payload = clients;
          dispatch_semaphore_signal(sem);
        });
    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5.0 * NSEC_PER_SEC));
    if (dispatch_semaphore_wait(sem, timeout) != 0) {
        printErrf(@"MRMediaRemoteGetNowPlayingClients timed out");
        return @[];
    }
    if (!payload) return @[];
    if ([payload isKindOfClass:[NSArray class]]) return payload;
    if ([payload isKindOfClass:[NSSet class]]) return [(NSSet *)payload allObjects];
    return @[payload];
}

void adapter_probe(void) {
    const char *mode = getenv("PROBE_MODE");
    printf("probe: mode=%s\n", mode ?: "(clients)");
    fflush(stdout);

    void *mediaRemote = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote",
                               RTLD_LAZY);
    if (!mediaRemote) {
        printf("probe: dlopen failed: %s\n", dlerror());
        fflush(stdout);
        return;
    }

    NSArray *clients = collectClients(mediaRemote);
    printf("  clients count=%lu\n", (unsigned long)clients.count);
    for (id client in clients) {
        printf("    class=%s bundle=%s\n", class_getName(object_getClass(client)),
               clientBundle(client).UTF8String);
    }
    fflush(stdout);
    if (!mode || clients.count == 0) return;

    dispatch_group_t group = dispatch_group_create();
    BOOL useQueueFirst = YES;

    if (strcmp(mode, "info1") == 0 || strcmp(mode, "info2") == 0) {
        void *raw = dlsym(mediaRemote, "MRMediaRemoteGetNowPlayingInfoForClient");
        if (!raw) { printErrf(@"MRMediaRemoteGetNowPlayingInfoForClient missing"); return; }
        useQueueFirst = (strcmp(mode, "info1") == 0);
        printf("  MRMediaRemoteGetNowPlayingInfoForClient (%s first)\n",
               useQueueFirst ? "queue" : "client");
        fflush(stdout);
        for (id client in clients) {
            printf("  client=%s\n", clientBundle(client).UTF8String);
            fflush(stdout);
            dispatch_group_enter(group);
            if (useQueueFirst)
                ((QueueIdBlock_t)raw)(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                                      client, ^(id info) {
                                        printInfo(info);
                                        dispatch_group_leave(group);
                                      });
            else
                ((IdQueueBlock_t)raw)(client,
                                      dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                                      ^(id info) {
                                        printInfo(info);
                                        dispatch_group_leave(group);
                                      });
        }
    } else if (strcmp(mode, "state1") == 0 || strcmp(mode, "state2") == 0) {
        void *raw = dlsym(mediaRemote, "MRMediaRemoteGetPlaybackStateForClient");
        if (!raw) { printErrf(@"MRMediaRemoteGetPlaybackStateForClient missing"); return; }
        useQueueFirst = (strcmp(mode, "state1") == 0);
        printf("  MRMediaRemoteGetPlaybackStateForClient (%s first)\n",
               useQueueFirst ? "queue" : "client");
        fflush(stdout);
        for (id client in clients) {
            printf("  client=%s\n", clientBundle(client).UTF8String);
            fflush(stdout);
            dispatch_group_enter(group);
            if (useQueueFirst)
                ((QueueIdIntBlock_t)raw)(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                                         client, ^(int state) {
                                           printf("    state=%d\n", state);
                                           fflush(stdout);
                                           dispatch_group_leave(group);
                                         });
            else
                ((IdQueueIntBlock_t)raw)(client,
                                         dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                                         ^(int state) {
                                           printf("    state=%d\n", state);
                                           fflush(stdout);
                                           dispatch_group_leave(group);
                                         });
        }
    } else if (strcmp(mode, "app1") == 0 || strcmp(mode, "app2") == 0) {
        void *raw = dlsym(mediaRemote, "MRMediaRemoteGetNowPlayingInfoForApp");
        if (!raw) { printErrf(@"MRMediaRemoteGetNowPlayingInfoForApp missing"); return; }
        BOOL queueFirst = (strcmp(mode, "app1") == 0);
        printf("  MRMediaRemoteGetNowPlayingInfoForApp (%s first)\n",
               queueFirst ? "queue" : "bundle");
        fflush(stdout);
        for (id client in clients) {
            NSString *bundle = clientBundle(client);
            printf("  bundle=%s\n", bundle.UTF8String);
            fflush(stdout);
            dispatch_group_enter(group);
            if (queueFirst)
                ((QueueStrBlock_t)raw)(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                                       bundle, ^(id info) {
                                         printInfo(info);
                                         dispatch_group_leave(group);
                                       });
            else
                ((IdQueueBlock2_t)raw)(bundle,
                                       dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0),
                                       ^(id info) {
                                         printInfo(info);
                                         dispatch_group_leave(group);
                                       });
        }
    } else if (strcmp(mode, "front") == 0) {
        void *raw = dlsym(mediaRemote, "MRMediaRemoteGetNowPlayingInfo");
        if (!raw) { printErrf(@"MRMediaRemoteGetNowPlayingInfo missing"); return; }
        printf("  MRMediaRemoteGetNowPlayingInfo (front app)\n");
        fflush(stdout);
        dispatch_group_enter(group);
        ((QueueBlock_t)raw)(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^(id info) {
          printInfo(info);
          dispatch_group_leave(group);
        });
    } else if (strcmp(mode, "origin") == 0) {
        void *raw = dlsym(mediaRemote, "MRMediaRemoteGetLocalOrigin");
        if (!raw) { printErrf(@"MRMediaRemoteGetLocalOrigin missing"); return; }
        id origin = ((id (*)(void))raw)();
        printf("  local origin: %s -> %s\n",
               origin ? class_getName(object_getClass(origin)) : "(nil)",
               origin ? [[origin description] UTF8String] : "");
        fflush(stdout);
        return;
    } else if (strcmp(mode, "info-int") == 0 || strcmp(mode, "info-void") == 0 ||
               strcmp(mode, "info-two") == 0 || strcmp(mode, "info-raw") == 0 ||
               strcmp(mode, "app5") == 0 || strcmp(mode, "players") == 0) {
        BOOL isState = NO;
        const char *symbolName = "MRMediaRemoteGetNowPlayingInfoForClient";
        if (strcmp(mode, "app5") == 0) symbolName = "MRMediaRemoteGetNowPlayingInfoForApp";
        if (strcmp(mode, "players") == 0) symbolName = "MRMediaRemoteGetPlayersForClient";
        void *raw = dlsym(mediaRemote, symbolName);
        if (!raw) { printErrf(@"%s missing", symbolName); return; }
        void *rawOrigin = dlsym(mediaRemote, "MRMediaRemoteGetLocalOrigin");
        if (!rawOrigin) { printErrf(@"MRMediaRemoteGetLocalOrigin missing"); return; }
        id origin = ((id (*)(void))rawOrigin)();
        printf("  %s layout=%s\n", symbolName, mode);
        fflush(stdout);
        for (id client in clients) {
            printf("  client=%s\n", clientBundle(client).UTF8String);
            fflush(stdout);
            dispatch_group_enter(group);
            dispatch_queue_t queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
            if (strcmp(mode, "info-int") == 0)
                ((void (*)(id, id, dispatch_queue_t, void (^)(int)))raw)(
                    client, origin, queue, ^(int value) {
                      printf("    cb(int)=%d\n", value);
                      fflush(stdout);
                      dispatch_group_leave(group);
                    });
            else if (strcmp(mode, "info-void") == 0)
                ((void (*)(id, id, dispatch_queue_t, void (^)(void)))raw)(client, origin, queue, ^{
                  printf("    cb(void)\n");
                  fflush(stdout);
                  dispatch_group_leave(group);
                });
            else if (strcmp(mode, "info-two") == 0)
                ((void (*)(id, id, dispatch_queue_t, void (^)(id, id)))raw)(
                    client, origin, queue, ^(id a, id b) {
                      printf("    cb(two) a=%s b=%s\n",
                             a ? class_getName(object_getClass(a)) : "(nil)",
                             b ? class_getName(object_getClass(b)) : "(nil)");
                      fflush(stdout);
                      dispatch_group_leave(group);
                    });
            else if (strcmp(mode, "info-raw") == 0)
                ((void (*)(id, id, dispatch_queue_t, void (^)(void *, int)))raw)(
                    client, origin, queue, ^(void *value, int flag) {
                      printf("    cb(ptr=%p flag=%d)\n", value, flag);
                      fflush(stdout);
                      dispatch_group_leave(group);
                    });
            else if (strcmp(mode, "app5") == 0)
                ((void (*)(id, id, dispatch_queue_t, IdCompletion))raw)(client, origin, queue,
                                                                        ^(id info) {
                                                                          printInfo(info);
                                                                          dispatch_group_leave(
                                                                              group);
                                                                        });
            else if (strcmp(mode, "players") == 0)
                ((void (*)(id, id, dispatch_queue_t, IdCompletion))raw)(client, origin, queue,
                                                                        ^(id players) {
                                                                          printf(
                                                                              "    players: %s\n",
                                                                              players
                                                                                  ? [[players description]
                                                                                         UTF8String]
                                                                                  : "(nil)");
                                                                          fflush(stdout);
                                                                          dispatch_group_leave(
                                                                              group);
                                                                        });
            (void)isState;
        }
    } else if (strcmp(mode, "info-player") == 0 || strcmp(mode, "ifp1") == 0 ||
               strcmp(mode, "ifp2") == 0 || strcmp(mode, "info-opt") == 0 ||
               strcmp(mode, "info-x2") == 0 || strcmp(mode, "info-x2b") == 0) {
        BOOL wantsInfoForClient = (strcmp(mode, "info-player") == 0 ||
                                   strcmp(mode, "info-opt") == 0 ||
                                   strcmp(mode, "info-x2") == 0 ||
                                   strcmp(mode, "info-x2b") == 0);
        const char *symbolName = wantsInfoForClient ? "MRMediaRemoteGetNowPlayingInfoForClient"
                                                    : "MRMediaRemoteGetNowPlayingInfoForPlayer";
        void *raw = dlsym(mediaRemote, symbolName);
        if (!raw) { printErrf(@"%s missing", symbolName); return; }
        void *rawOrigin = dlsym(mediaRemote, "MRMediaRemoteGetLocalOrigin");
        void *rawPlayers = dlsym(mediaRemote, "MRMediaRemoteGetPlayersForClient");
        if (!rawOrigin || !rawPlayers) { printErrf(@"origin/players symbol missing"); return; }
        id origin = ((id (*)(void))rawOrigin)();
        printf("  %s mode=%s origin=%s\n", symbolName, mode,
               origin ? class_getName(object_getClass(origin)) : "(nil)");
        fflush(stdout);

        for (id client in clients) {
            printf("  client=%s\n", clientBundle(client).UTF8String);
            fflush(stdout);
            dispatch_group_t perClient = dispatch_group_create();
            dispatch_group_enter(perClient);
            __block id firstPlayer = nil;
            dispatch_queue_t queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
            ((void (*)(id, id, dispatch_queue_t, IdCompletion))rawPlayers)(
                client, origin, queue, ^(id players) {
                  if ([players isKindOfClass:[NSArray class]] && [(NSArray *)players count])
                      firstPlayer = [(NSArray *)players firstObject];
                  else if (players && ![players isKindOfClass:[NSArray class]])
                      firstPlayer = players;
                  dispatch_group_leave(perClient);
                });
            dispatch_time_t t = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5.0 * NSEC_PER_SEC));
            if (dispatch_group_wait(perClient, t) != 0) {
                printf("    players timeout\n");
                fflush(stdout);
                continue;
            }
            printf("    player=%s\n",
                   firstPlayer ? class_getName(object_getClass(firstPlayer)) : "(nil)");
            fflush(stdout);
            if (!firstPlayer) continue;

            dispatch_group_enter(group);
            if (wantsInfoForClient) {
                if (strcmp(mode, "info-opt") == 0)
                    ((void (*)(id, id, dispatch_queue_t, NSDictionary *, IdCompletion))raw)(
                        client, origin, queue, @{}, ^(id info) {
                          printInfo(info);
                          dispatch_group_leave(group);
                        });
                else if (strcmp(mode, "info-x2") == 0)
                    ((void (*)(id, id, id, dispatch_queue_t, IdCompletion))raw)(
                        client, origin, firstPlayer, queue, ^(id info) {
                          printf("    info for %s\n", clientBundle(client).UTF8String);
                          fflush(stdout);
                          printInfo(info);
                          dispatch_group_leave(group);
                        });
                else if (strcmp(mode, "info-x2b") == 0)
                    ((void (*)(id, id, id, IdCompletion))raw)(
                        client, origin, firstPlayer, ^(id info) {
                          printInfo(info);
                          dispatch_group_leave(group);
                        });
                else
                    ((void (*)(id, id, dispatch_queue_t, id, IdCompletion))raw)(
                        client, origin, queue, firstPlayer, ^(id info) {
                          printInfo(info);
                          dispatch_group_leave(group);
                        });
            } else if (strcmp(mode, "ifp1") == 0)
                ((void (*)(id, id, dispatch_queue_t, IdCompletion))raw)(
                    firstPlayer, origin, queue, ^(id info) {
                      printInfo(info);
                      dispatch_group_leave(group);
                    });
            else
                ((void (*)(id, id, dispatch_queue_t, IdCompletion))raw)(
                    origin, firstPlayer, queue, ^(id info) {
                      printInfo(info);
                      dispatch_group_leave(group);
                    });
        }
    } else if (strncmp(mode, "state", 5) == 0 || strncmp(mode, "info", 4) == 0) {
        // Empirically deduced from the type checks inside MRPlayerPath:
        // argument 0 must be the MRClient, argument 1 the MROrigin.
        int layout = mode[strlen(mode) - 1] - '0';
        BOOL wantsState = (strncmp(mode, "state", 5) == 0);
        void *raw = dlsym(mediaRemote, wantsState ? "MRMediaRemoteGetPlaybackStateForClient"
                                                  : "MRMediaRemoteGetNowPlayingInfoForClient");
        if (!raw) { printErrf(@"per-client symbol missing"); return; }
        void *rawOrigin = dlsym(mediaRemote, "MRMediaRemoteGetLocalOrigin");
        if (!rawOrigin) { printErrf(@"MRMediaRemoteGetLocalOrigin missing"); return; }
        id origin = ((id (*)(void))rawOrigin)();
        printf("  origin=%s layout=%d %s(client, origin, ...)\n",
               origin ? class_getName(object_getClass(origin)) : "(nil)", layout,
               wantsState ? "GetPlaybackStateForClient" : "GetNowPlayingInfoForClient");
        fflush(stdout);
        for (id client in clients) {
            printf("  client=%s\n", clientBundle(client).UTF8String);
            fflush(stdout);
            dispatch_group_enter(group);
            dispatch_queue_t queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0);
            IdCompletion onInfo = ^(id info) {
              printInfo(info);
              dispatch_group_leave(group);
            };
            IntCompletion onState = ^(int state) {
              printf("    state=%d client=%s\n", state, clientBundle(client).UTF8String);
              fflush(stdout);
              dispatch_group_leave(group);
            };
            if (layout == 5)
                wantsState
                    ? ((void (*)(id, id, dispatch_queue_t, IntCompletion))raw)(client, origin, queue,
                                                                              onState)
                    : ((void (*)(id, id, dispatch_queue_t, IdCompletion))raw)(client, origin, queue,
                                                                             onInfo);
            else if (layout == 6)
                wantsState
                    ? ((void (*)(id, id, dispatch_queue_t, id, IntCompletion))raw)(client, origin,
                                                                                   queue, nil,
                                                                                   onState)
                    : ((void (*)(id, id, dispatch_queue_t, id, IdCompletion))raw)(client, origin,
                                                                                  queue, nil,
                                                                                  onInfo);
            else if (layout == 7)
                wantsState
                    ? ((void (*)(id, id, IntCompletion))raw)(client, origin, onState)
                    : ((void (*)(id, id, IdCompletion))raw)(client, origin, onInfo);
            else if (layout == 8)
                wantsState
                    ? ((void (*)(id, dispatch_queue_t, IntCompletion))raw)(client, queue, onState)
                    : ((void (*)(id, dispatch_queue_t, IdCompletion))raw)(client, queue, onInfo);
            else {
                printf("    onbekende layout\n");
                dispatch_group_leave(group);
            }
        }
    } else if (strcmp(mode, "setclient") == 0) {
        // Make one client the now playing application for the local origin,
        // after which the ordinary MRMediaRemoteSendCommand reaches it.
        const char *bundleEnv = getenv("PROBE_BUNDLE");
        NSString *want = bundleEnv ? [NSString stringWithUTF8String:bundleEnv] : @"com.apple.Music";
        int order = 1;
        if (getenv("PROBE_ORDER")) order = atoi(getenv("PROBE_ORDER"));
        id target = nil;
        for (id client in clients) {
            if ([clientBundle(client) isEqualToString:want]) {
                target = client;
                break;
            }
        }
        if (!target) {
            printf("  setclient: no client for %s\n", want.UTF8String);
            fflush(stdout);
            return;
        }
        void *raw = dlsym(mediaRemote, "MRMediaRemoteSetNowPlayingClientForOrigin");
        void *rawOrigin = dlsym(mediaRemote, "MRMediaRemoteGetLocalOrigin");
        id origin = rawOrigin ? ((id (*)(void))rawOrigin)() : nil;
        if (!raw || !origin) {
            printf("  setclient: missing symbol=%d origin=%d\n", raw != NULL, origin != nil);
            fflush(stdout);
            return;
        }
        bool result = false;
        if (order == 1) {
            typedef void (*OriginFirst_t)(id, id);
            ((OriginFirst_t)raw)(origin, target);
            result = true;
        } else {
            typedef void (*ClientFirst_t)(id, id);
            ((ClientFirst_t)raw)(target, origin);
            result = true;
        }
        printf("  setclient: order=%d target=%s origin=%s result=%s\n", order, want.UTF8String,
               class_getName(object_getClass(origin)), result ? "true" : "false");
        fflush(stdout);
        return;
    } else if (strcmp(mode, "sendapp") == 0) {
        // MRMediaRemoteSendCommandToApp may address the player by bundle id,
        // which sidesteps the player path that SendCommandToClient chokes on.
        const char *bundleEnv = getenv("PROBE_BUNDLE");
        NSString *want = bundleEnv ? [NSString stringWithUTF8String:bundleEnv] : @"com.apple.Music";
        int command = 1;
        if (getenv("PROBE_COMMAND")) command = atoi(getenv("PROBE_COMMAND"));
        int order = 1;
        if (getenv("PROBE_ORDER")) order = atoi(getenv("PROBE_ORDER"));
        void *raw = dlsym(mediaRemote, "MRMediaRemoteSendCommandToApp");
        void *rawOrigin = dlsym(mediaRemote, "MRMediaRemoteGetLocalOrigin");
        id origin = rawOrigin ? ((id (*)(void))rawOrigin)() : nil;
        if (!raw) {
            printErrf(@"MRMediaRemoteSendCommandToApp is not exported");
            return;
        }
        bool result = false;
        if (order == 1) {
            typedef bool (*A_t)(int, id, id);
            result = ((A_t)raw)(command, nil, want);
        } else if (order == 2) {
            typedef bool (*B_t)(id, int, id);
            result = ((B_t)raw)(want, command, nil);
        } else if (order == 3) {
            typedef bool (*C_t)(int, id, id, id);
            result = ((C_t)raw)(command, nil, origin, want);
        } else {
            typedef bool (*D_t)(id, id, int, id);
            result = ((D_t)raw)(origin, want, command, nil);
        }
        printf("  sendapp: order=%d command=%d result=%s\n", order, command,
               result ? "true" : "false");
        fflush(stdout);
        return;
    } else if (strcmp(mode, "sendpath") == 0) {
        // Build the player path ourselves and hand it to the plain send
        // command through the userInfo, which is how MediaRemote itself
        // addresses a single client.
        const char *bundleEnv = getenv("PROBE_BUNDLE");
        NSString *want = bundleEnv ? [NSString stringWithUTF8String:bundleEnv] : @"com.apple.Music";
        int command = 1;
        if (getenv("PROBE_COMMAND")) command = atoi(getenv("PROBE_COMMAND"));
        int order = 1;
        if (getenv("PROBE_ORDER")) order = atoi(getenv("PROBE_ORDER"));
        id target = nil;
        for (id client in clients) {
            if ([clientBundle(client) isEqualToString:want]) {
                target = client;
                break;
            }
        }
        void *rawOrigin = dlsym(mediaRemote, "MRMediaRemoteGetLocalOrigin");
        id origin = rawOrigin ? ((id (*)(void))rawOrigin)() : nil;
        Class pathCls = NSClassFromString(@"MRPlayerPath");
        if (!target || !origin || !pathCls) {
            printf("  sendpath: target=%d origin=%d class=%d\n", target != nil, origin != nil,
                   pathCls != Nil);
            fflush(stdout);
            return;
        }
        id alloced = ((id (*)(id, SEL))objc_msgSend)((id)pathCls, @selector(alloc));
        id path = ((id (*)(id, SEL, id, id, id))objc_msgSend)(
            alloced, @selector(initWithOrigin:client:player:), origin, target, nil);
        printf("  path=%s\n", path ? class_getName(object_getClass(path)) : "(nil)");
        fflush(stdout);
        void *addPath = dlsym(mediaRemote, "MRAddPlayerPathToUserInfo");
        NSMutableDictionary *info = [NSMutableDictionary dictionary];
        if (addPath) {
            if (order == 1) {
                ((void (*)(id, id))addPath)(info, path);
            } else {
                ((void (*)(id, id))addPath)(path, info);
            }
        }
        id userInfo = info;
        printf("  userInfo=%s\n",
               userInfo ? class_getName(object_getClass(userInfo)) : "(nil)");
        fflush(stdout);
        void *rawSend = dlsym(mediaRemote, "MRMediaRemoteSendCommand");
        bool result = false;
        if (rawSend && userInfo) {
            result = ((bool (*)(int, id))rawSend)(command, userInfo);
        }
        printf("  sendpath: order=%d command=%d result=%s\n", order, command,
               result ? "true" : "false");
        fflush(stdout);
        return;
    } else if (strcmp(mode, "clientdump") == 0) {
        // What does an MRClient actually expose? Needed to work out how a
        // transport command is addressed to one client instead of the front
        // application.
        const char *bundleEnv = getenv("PROBE_BUNDLE");
        NSString *want = bundleEnv ? [NSString stringWithUTF8String:bundleEnv] : @"com.apple.Music";
        id target = nil;
        for (id client in clients) {
            if ([clientBundle(client) isEqualToString:want]) {
                target = client;
                break;
            }
        }
        if (!target) {
            printf("  clientdump: no client for %s\n", want.UTF8String);
            fflush(stdout);
            return;
        }
        Class cls = object_getClass(target);
        printf("  clientdump: class=%s\n", class_getName(cls));
        unsigned int count = 0;
        objc_property_t *props = class_copyPropertyList(cls, &count);
        printf("  properties (%u):\n", count);
        for (unsigned int i = 0; i < count; i++) printf("    %s\n", property_getName(props[i]));
        free(props);
        count = 0;
        Method *methods = class_copyMethodList(cls, &count);
        printf("  methods (%u):\n", count);
        for (unsigned int i = 0; i < count; i++)
            printf("    %s\n", sel_getName(method_getName(methods[i])));
        free(methods);
        fflush(stdout);
        return;
    } else if (strcmp(mode, "sendclient") == 0) {
        // Send a transport command to one specific now playing client instead
        // of to whatever MediaRemote has in front. The argument order of
        // MRMediaRemoteSendCommandToClient is guessed, so PROBE_ORDER picks
        // the layout and the effect has to be observed from outside.
        const char *bundleEnv = getenv("PROBE_BUNDLE");
        NSString *want = bundleEnv ? [NSString stringWithUTF8String:bundleEnv] : @"com.apple.Music";
        int command = 1;
        if (getenv("PROBE_COMMAND")) command = atoi(getenv("PROBE_COMMAND"));
        int order = 1;
        if (getenv("PROBE_ORDER")) order = atoi(getenv("PROBE_ORDER"));

        id target = nil;
        for (id client in clients) {
            if ([clientBundle(client) isEqualToString:want]) {
                target = client;
                break;
            }
        }
        if (!target) {
            printf("  sendclient: no client for %s\n", want.UTF8String);
            fflush(stdout);
            return;
        }
        if (getenv("PROBE_FRESH")) {
            // The objects from GetNowPlayingClients carry protobuf skeletons
            // with unresolved placeholders, which the player path cannot walk.
            // Rebuild the client from its two plain fields instead.
            int pid = 0;
            if ([target respondsToSelector:@selector(processIdentifier)]) {
                pid = [[target valueForKey:@"processIdentifier"] intValue];
            }
            Class cls = NSClassFromString(@"MRClient");
            id rebuilt = nil;
            if (cls) {
                id fresh = ((id (*)(id, SEL))objc_msgSend)((id)cls, @selector(alloc));
                rebuilt = ((id (*)(id, SEL, int, NSString *))objc_msgSend)(
                    fresh, @selector(initWithProcessIdentifier:bundleIdentifier:), pid, want);
            }
            printf("  fresh client pid=%d class=%s\n", pid,
                   rebuilt ? class_getName(object_getClass(rebuilt)) : "(nil)");
            fflush(stdout);
            if (rebuilt) target = rebuilt;
        }
        void *raw = dlsym(mediaRemote, "MRMediaRemoteSendCommandToClient");
        if (!raw) {
            printErrf(@"MRMediaRemoteSendCommandToClient is not exported");
            return;
        }
        id origin = nil;
        const char *originKind = getenv("PROBE_ORIGIN");
        const char *originName = (!originKind || strcmp(originKind, "active") != 0)
                                     ? "MRMediaRemoteGetLocalOrigin"
                                     : "MRMediaRemoteGetActiveOrigin";
        void *rawOrigin = dlsym(mediaRemote, originName);
        if (rawOrigin) origin = ((id (*)(void))rawOrigin)();
        printf("  origin=%s from %s\n", origin ? class_getName(object_getClass(origin)) : "(nil)",
               originName);
        fflush(stdout);

        bool result = false;
        if (order == 1) {
            typedef bool (*ClientFirst_t)(id, int, id);
            result = ((ClientFirst_t)raw)(target, command, nil);
        } else if (order == 2) {
            typedef bool (*CommandFirst_t)(int, id, id);
            result = ((CommandFirst_t)raw)(command, nil, target);
        } else if (order == 3) {
            typedef bool (*WithOrigin_t)(int, id, id, id);
            result = ((WithOrigin_t)raw)(command, nil, origin, target);
        } else if (order == 5) {
            typedef bool (*ClientOrigin_t)(id, int, id, id);
            result = ((ClientOrigin_t)raw)(target, command, nil, origin);
        } else if (order == 6) {
            typedef bool (*OriginThenClient_t)(int, id, id, id, id);
            result = ((OriginThenClient_t)raw)(command, nil, origin, nil, target);
        } else if (order == 7) {
            typedef bool (*CommandClient_t)(int, id, id);
            result = ((CommandClient_t)raw)(command, target, nil);
        } else if (order == 8) {
            typedef bool (*OriginClient_t)(id, id, int, id);
            result = ((OriginClient_t)raw)(origin, target, command, nil);
        } else if (order == 9) {
            typedef bool (*NoOrigin_t)(int, id, id, id);
            result = ((NoOrigin_t)raw)(command, nil, nil, target);
        } else if (order == 10) {
            typedef bool (*NoOriginPlayer_t)(int, id, id, id, id);
            result = ((NoOriginPlayer_t)raw)(command, nil, nil, target, nil);
        } else {
            typedef bool (*Six_t)(int, id, id, id, id, id);
            result = ((Six_t)raw)(command, nil, origin, target, nil, nil);
        }
        printf("  sendclient: order=%d command=%d target=%s result=%s\n", order, command,
               want.UTF8String, result ? "true" : "false");
        fflush(stdout);
        return;
    } else {
        printf("  unknown PROBE_MODE '%s'\n", mode);
        fflush(stdout);
        return;
    }

    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, (int64_t)(8.0 * NSEC_PER_SEC));
    if (dispatch_group_wait(group, timeout) != 0) {
        printErrf(@"per-client call timed out");
        return;
    }
    printf("probe: done\n");
    fflush(stdout);
}
