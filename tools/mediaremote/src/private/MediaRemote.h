// clang-format off

#ifndef MEDIAREMOTE_PRIVATE_H_
#define MEDIAREMOTE_PRIVATE_H_

#include <Foundation/Foundation.h>

#pragma mark Notifications

extern NSString *kMRMediaRemoteNowPlayingInfoDidChangeNotification;
extern NSString *kMRMediaRemoteNowPlayingPlaybackQueueDidChangeNotification;
extern NSString *kMRMediaRemotePickableRoutesDidChangeNotification;
extern NSString *kMRMediaRemoteNowPlayingApplicationDidChangeNotification;
extern NSString *kMRMediaRemoteNowPlayingApplicationIsPlayingDidChangeNotification;
extern NSString *kMRMediaRemoteRouteStatusDidChangeNotification;

#pragma mark Keys

extern NSString *kMRMediaRemoteNowPlayingApplicationPIDUserInfoKey;
extern NSString *kMRMediaRemoteNowPlayingApplicationIsPlayingUserInfoKey;
extern NSString *kMRMediaRemoteNowPlayingInfoAlbum;
extern NSString *kMRMediaRemoteNowPlayingInfoArtist;
extern NSString *kMRMediaRemoteNowPlayingInfoArtworkData;
extern NSString *kMRMediaRemoteNowPlayingInfoArtworkMIMEType;
extern NSString *kMRMediaRemoteNowPlayingInfoChapterNumber;
extern NSString *kMRMediaRemoteNowPlayingInfoComposer;
extern NSString *kMRMediaRemoteNowPlayingInfoDuration;
extern NSString *kMRMediaRemoteNowPlayingInfoElapsedTime;
extern NSString *kMRMediaRemoteNowPlayingInfoGenre;
extern NSString *kMRMediaRemoteNowPlayingInfoIsAdvertisement;
extern NSString *kMRMediaRemoteNowPlayingInfoIsBanned;
extern NSString *kMRMediaRemoteNowPlayingInfoIsInWishList;
extern NSString *kMRMediaRemoteNowPlayingInfoIsLiked;
extern NSString *kMRMediaRemoteNowPlayingInfoIsMusicApp;
extern NSString *kMRMediaRemoteNowPlayingInfoPlaybackRate;
extern NSString *kMRMediaRemoteNowPlayingInfoProhibitsSkip;
extern NSString *kMRMediaRemoteNowPlayingInfoQueueIndex;
extern NSString *kMRMediaRemoteNowPlayingInfoRadioStationIdentifier;
extern NSString *kMRMediaRemoteNowPlayingInfoRepeatMode;
extern NSString *kMRMediaRemoteNowPlayingInfoShuffleMode;
extern NSString *kMRMediaRemoteNowPlayingInfoStartTime;
extern NSString *kMRMediaRemoteNowPlayingInfoSupportsFastForward15Seconds;
extern NSString *kMRMediaRemoteNowPlayingInfoSupportsIsBanned;
extern NSString *kMRMediaRemoteNowPlayingInfoSupportsIsLiked;
extern NSString *kMRMediaRemoteNowPlayingInfoSupportsRewind15Seconds;
extern NSString *kMRMediaRemoteNowPlayingInfoTimestamp;
extern NSString *kMRMediaRemoteNowPlayingInfoTitle;
extern NSString *kMRMediaRemoteNowPlayingInfoTotalChapterCount;
extern NSString *kMRMediaRemoteNowPlayingInfoTotalDiscCount;
extern NSString *kMRMediaRemoteNowPlayingInfoTotalQueueCount;
extern NSString *kMRMediaRemoteNowPlayingInfoTotalTrackCount;
extern NSString *kMRMediaRemoteNowPlayingInfoTrackNumber;
extern NSString *kMRMediaRemoteNowPlayingInfoUniqueIdentifier;
extern NSString *kMRMediaRemoteNowPlayingInfoContentItemIdentifier;
extern NSString *kMRMediaRemoteNowPlayingInfoRadioStationHash;
extern NSString *kMRMediaRemoteNowPlayingInfoMediaType;
extern NSString *kMRMediaRemoteNowPlayingInfoServiceIdentifier;
extern NSString *kMRMediaRemoteOptionMediaType;
extern NSString *kMRMediaRemoteOptionSourceID;
extern NSString *kMRMediaRemoteOptionTrackID;
extern NSString *kMRMediaRemoteOptionStationID;
extern NSString *kMRMediaRemoteOptionStationHash;
extern NSString *kMRMediaRemoteRouteDescriptionUserInfoKey;
extern NSString *kMRMediaRemoteRouteStatusUserInfoKey;

#pragma mark API

typedef enum {
    /*
     * Use nil for userInfo.
     */
    kMRPlay = 0,
    kMRPause = 1,
    kMRTogglePlayPause = 2,
    kMRStop = 3,
    kMRNextTrack = 4,
    kMRPreviousTrack = 5,
    kMRToggleShuffle = 6,
    kMRToggleRepeat = 7,
    kMRStartForwardSeek = 8,
    kMREndForwardSeek = 9,
    kMRStartBackwardSeek = 10,
    kMREndBackwardSeek = 11,
    kMRGoBackFifteenSeconds = 12,
    kMRSkipFifteenSeconds = 13,

    /*
     * Use a NSDictionary for userInfo, which contains three keys:
     * kMRMediaRemoteOptionTrackID
     * kMRMediaRemoteOptionStationID
     * kMRMediaRemoteOptionStationHash
     */
    kMRLikeTrack = 0x6A,
    kMRBanTrack = 0x6B,
    kMRAddTrackToWishList = 0x6C,
    kMRRemoveTrackFromWishList = 0x6D
} MRCommand;

extern CFStringRef MRMediaRemoteSendCommand;
typedef bool (*MRMediaRemoteSendCommand_t)(MRCommand command, id userInfo);

// Stamps a player path into the userInfo of MRMediaRemoteSendCommand, which is
// how a command is aimed at one client instead of at the application that
// MediaRemote happens to have in front.
extern CFStringRef MRAddPlayerPathToUserInfo;
typedef void (*MRAddPlayerPathToUserInfo_t)(NSMutableDictionary *userInfo, id playerPath);

extern CFStringRef MRMediaRemoteSetPlaybackSpeed;
extern CFStringRef MRMediaRemoteSetElapsedTime;
extern CFStringRef MRMediaRemoteSetShuffleMode;
extern CFStringRef MRMediaRemoteSetRepeatMode;
typedef void (*MRMediaRemoteSetPlaybackSpeed_t)(int speed);
typedef void (*MRMediaRemoteSetElapsedTime_t)(double elapsedTime);
typedef void (*MRMediaRemoteSetShuffleMode_t)(int mode);
typedef void (*MRMediaRemoteSetRepeatMode_t)(int mode);

extern CFStringRef MRMediaRemoteRegisterForNowPlayingNotifications;
extern CFStringRef MRMediaRemoteUnregisterForNowPlayingNotifications;
extern CFStringRef MRMediaRemoteGetNowPlayingApplicationPID;
extern CFStringRef MRMediaRemoteGetNowPlayingClient;
extern CFStringRef MRMediaRemoteGetNowPlayingInfo;
extern CFStringRef MRMediaRemoteGetNowPlayingApplicationIsPlaying;
extern CFStringRef MRMediaRemoteGetNowPlayingClients;
extern CFStringRef MRMediaRemoteGetLocalOrigin;
extern CFStringRef MRMediaRemoteGetPlaybackStateForClient;
extern CFStringRef MRMediaRemoteGetNowPlayingInfoForClient;
extern CFStringRef MRMediaRemoteGetPlayersForClient;

typedef void (*MRMediaRemoteRegisterForNowPlayingNotifications_t)(dispatch_queue_t queue);
typedef void (*MRMediaRemoteUnregisterForNowPlayingNotifications_t)();

typedef void (^MRMediaRemoteGetNowPlayingInfoCompletion_t)(NSDictionary *information);
typedef void (^MRMediaRemoteGetNowPlayingApplicationPIDCompletion_t)(int PID);
typedef void (^MRMediaRemoteGetNowPlayingClientCompletion_t)(id clientObj);
typedef void (^MRMediaRemoteGetNowPlayingApplicationIsPlayingCompletion_t)(bool isPlaying);

typedef void (*MRMediaRemoteGetNowPlayingApplicationPID_t)(dispatch_queue_t queue, MRMediaRemoteGetNowPlayingApplicationPIDCompletion_t completion);
typedef void (*MRMediaRemoteGetNowPlayingClient_t)(dispatch_queue_t queue, MRMediaRemoteGetNowPlayingClientCompletion_t completion);
typedef void (*MRMediaRemoteGetNowPlayingInfo_t)(dispatch_queue_t queue, MRMediaRemoteGetNowPlayingInfoCompletion_t completion);
typedef void (*MRMediaRemoteGetNowPlayingApplicationIsPlaying_t)(dispatch_queue_t queue, MRMediaRemoteGetNowPlayingApplicationIsPlayingCompletion_t completion);

// Per-client accessors. MediaRemote only ever hands out now playing
// information for a single "front" application, which is the one that
// registered last rather than the one that is actually playing. These
// resolve information for a specific now playing client instead.
//
// Argument order was determined empirically on macOS 27: the client goes in
// first, then the local origin, and the info call additionally takes the
// client's player object (obtained through GetPlayersForClient).
typedef void (^MRMediaRemoteGetNowPlayingClientsCompletion_t)(id clients);
typedef void (^MRMediaRemoteGetPlayersForClientCompletion_t)(id players);
typedef void (^MRMediaRemoteGetPlaybackStateForClientCompletion_t)(int state);

typedef id (*MRMediaRemoteGetLocalOrigin_t)(void);
typedef void (*MRMediaRemoteGetNowPlayingClients_t)(dispatch_queue_t queue, MRMediaRemoteGetNowPlayingClientsCompletion_t completion);
typedef void (*MRMediaRemoteGetPlayersForClient_t)(id client, id origin, dispatch_queue_t queue, MRMediaRemoteGetPlayersForClientCompletion_t completion);
typedef void (*MRMediaRemoteGetPlaybackStateForClient_t)(id client, id origin, dispatch_queue_t queue, MRMediaRemoteGetPlaybackStateForClientCompletion_t completion);
typedef void (*MRMediaRemoteGetNowPlayingInfoForClient_t)(id client, id origin, id player, dispatch_queue_t queue, MRMediaRemoteGetNowPlayingInfoCompletion_t completion);

#pragma mark Miscellaneous

extern NSString *kMRNowPlayingClientUserInfoKey;

// Accessed with the kMRNowPlayingClientUserInfoKey
// on the userInfo dictionary of an NSNotification.
@interface MRClient : NSObject {}
-(NSString *)parentApplicationBundleIdentifier;
-(NSString *)bundleIdentifier;
-(NSString *)displayName;
-(int)processIdentifier;
@end

@interface MediaRemote : NSObject
// Commands
@property(readonly) MRMediaRemoteSendCommand_t sendCommand;
@property(readonly) MRAddPlayerPathToUserInfo_t addPlayerPathToUserInfo;
// Other controls
@property(readonly) MRMediaRemoteSetPlaybackSpeed_t setPlaybackSpeed;
@property(readonly) MRMediaRemoteSetElapsedTime_t setElapsedTime;
@property(readonly) MRMediaRemoteSetShuffleMode_t setShuffleMode;
@property(readonly) MRMediaRemoteSetRepeatMode_t setRepeatMode;
// Observers
@property(readonly) MRMediaRemoteRegisterForNowPlayingNotifications_t registerForNowPlayingNotifications;
@property(readonly) MRMediaRemoteUnregisterForNowPlayingNotifications_t unregisterForNowPlayingNotifications;
// Metadata
@property(readonly) MRMediaRemoteGetNowPlayingApplicationPID_t getNowPlayingApplicationPID;
@property(readonly) MRMediaRemoteGetNowPlayingClient_t getNowPlayingClient;
@property(readonly) MRMediaRemoteGetNowPlayingInfo_t getNowPlayingInfo;
@property(readonly) MRMediaRemoteGetNowPlayingApplicationIsPlaying_t getNowPlayingApplicationIsPlaying;
// Per client
@property(readonly) MRMediaRemoteGetLocalOrigin_t getLocalOrigin;
@property(readonly) MRMediaRemoteGetNowPlayingClients_t getNowPlayingClients;
@property(readonly) MRMediaRemoteGetPlayersForClient_t getPlayersForClient;
@property(readonly) MRMediaRemoteGetPlaybackStateForClient_t getPlaybackStateForClient;
@property(readonly) MRMediaRemoteGetNowPlayingInfoForClient_t getNowPlayingInfoForClient;
// Constructor
-(id)init;
@end

#endif /* MEDIAREMOTE_PRIVATE_H_ */
