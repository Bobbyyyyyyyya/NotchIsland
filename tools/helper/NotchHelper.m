//
//  NotchHelper.m
//  A tiny always-on companion for Notch Island.
//
//  Electron cannot reach CoreAudio or MediaPlayer's remote command centre, so
//  this helper does it and speaks newline delimited JSON over stdio.
//
//      stdin   {"cmd":"play"}  {"cmd":"setOutput","id":42}  ...
//      stdout  {"event":"nowPlaying",...}  {"event":"devices",...}
//
//  Build:  clang -fobjc-arc -O2 -framework Foundation -framework AppKit \
//                 -framework MediaPlayer -framework CoreAudio \
//                 -framework CoreGraphics NotchHelper.m -o NotchHelper
//

#import <ifaddrs.h>
#import <SystemConfiguration/SystemConfiguration.h>
#import <AppKit/AppKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CallKit/CallKit.h>
#import <CoreAudio/CoreAudio.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/hid/IOHIDManager.h>
#import <IOKit/ps/IOPSKeys.h>
#import <IOKit/ps/IOPowerSources.h>
#import <IOBluetooth/IOBluetooth.h>
#import <MediaPlayer/MediaPlayer.h>
#import <dlfcn.h>
#import <errno.h>
#import <unistd.h>
#import <objc/message.h>
#import <objc/runtime.h>

#pragma mark - IO

static void Emit(NSDictionary *payload) {
    if (![NSJSONSerialization isValidJSONObject:payload]) return;
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
    if (!data) return;
    NSMutableData *line = [data mutableCopy];
    [line appendBytes:"\n" length:1];
    fwrite(line.bytes, 1, line.length, stdout);
    fflush(stdout);
}

#pragma mark - CoreAudio helpers

// CoreAudio accepts CFString selectors for a handful of properties even though
// the SDK types mSelector as a UInt32.
static inline AudioObjectPropertySelector StringSelector(CFStringRef string) {
    union { CFStringRef string; AudioObjectPropertySelector selector; } bridge;
    bridge.string = string;
    return bridge.selector;
}

static BOOL ReadAudioProperty(AudioObjectID device, AudioObjectPropertySelector selector,
                              AudioObjectPropertyScope scope, AudioObjectPropertyElement element,
                              void *out, UInt32 size) {
    AudioObjectPropertyAddress address = {selector, scope, element};
    if (!AudioObjectHasProperty(device, &address)) return NO;
    UInt32 dataSize = size;
    return AudioObjectGetPropertyData(device, &address, 0, NULL, &dataSize, out) == noErr;
}

static BOOL WriteAudioProperty(AudioObjectID device, AudioObjectPropertySelector selector,
                               AudioObjectPropertyScope scope, AudioObjectPropertyElement element,
                               const void *value, UInt32 size) {
    AudioObjectPropertyAddress address = {selector, scope, element};
    if (!AudioObjectHasProperty(device, &address)) return NO;
    return AudioObjectSetPropertyData(device, &address, 0, NULL, size, value) == noErr;
}

static BOOL ReadAudioPropertyString(AudioObjectID device, AudioObjectPropertySelector selector,
                                    AudioObjectPropertyScope scope, CFStringRef *out) {
    AudioObjectPropertyAddress address = {selector, scope, kAudioObjectPropertyElementMain};
    if (!AudioObjectHasProperty(device, &address)) return NO;
    UInt32 size = sizeof(CFStringRef);
    return AudioObjectGetPropertyData(device, &address, 0, NULL, &size, out) == noErr;
}

static AudioObjectID DefaultDevice(BOOL isInput) {
    AudioObjectID device = kAudioObjectUnknown;
    AudioObjectPropertySelector selector = isInput ? kAudioHardwarePropertyDefaultInputDevice
                                                  : kAudioHardwarePropertyDefaultOutputDevice;
    if (!ReadAudioProperty(kAudioObjectSystemObject, selector, kAudioObjectPropertyScopeGlobal,
                           kAudioObjectPropertyElementMain, &device, sizeof(device)))
        return kAudioObjectUnknown;
    return device;
}

static NSString *DeviceName(AudioObjectID device) {
    CFStringRef name = NULL;
    if (!ReadAudioPropertyString(device, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal, &name))
        return @"Unknown device";
    return (__bridge_transfer NSString *)name ?: @"Unknown device";
}

static NSString *DeviceUID(AudioObjectID device) {
    CFStringRef uid = NULL;
    if (!ReadAudioPropertyString(device, kAudioDevicePropertyDeviceUID, kAudioObjectPropertyScopeGlobal, &uid))
        return @"";
    return (__bridge_transfer NSString *)uid ?: @"";
}

static BOOL DeviceIsRunning(AudioObjectID device, BOOL isInput) {
    UInt32 running = 0;
    AudioObjectPropertyScope scope = isInput ? kAudioDevicePropertyScopeInput : kAudioObjectPropertyScopeOutput;
    if (!ReadAudioProperty(device, kAudioDevicePropertyDeviceIsRunningSomewhere, scope,
                           kAudioObjectPropertyElementMain, &running, sizeof(running)))
        return NO;
    return running != 0;
}

static NSInteger DeviceChannelCount(AudioObjectID device, BOOL isInput) {
    UInt32 size = 0;
    AudioObjectPropertyAddress address = {
        kAudioDevicePropertyStreamConfiguration,
        isInput ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput,
        kAudioObjectPropertyElementMain};
    if (!AudioObjectHasProperty(device, &address)) return 0;
    if (AudioObjectGetPropertyDataSize(device, &address, 0, NULL, &size) != noErr) return 0;
    if (size == 0 || size > 8192) return 0;

    AudioBufferList *buffers = calloc(1, size);
    if (!buffers) return 0;
    NSInteger channels = 0;
    if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, buffers) == noErr) {
        for (UInt32 i = 0; i < buffers->mNumberBuffers; i++) channels += buffers->mBuffers[i].mNumberChannels;
    }
    free(buffers);
    return channels;
}

#pragma mark - Volume

static void OutputSetMuted(BOOL muted);
static void InputSetMuted(BOOL muted);

static BOOL VolumeIsAvailable(void) {
    return DefaultDevice(NO) != kAudioObjectUnknown;
}

static BOOL HasVirtualMainVolume(AudioObjectID device) {
    AudioObjectPropertyAddress address = {StringSelector(CFSTR("VirtualMainVolume")),
                                          kAudioObjectPropertyScopeOutput,
                                          kAudioObjectPropertyElementMain};
    return AudioObjectHasProperty(device, &address);
}

static float VolumeCurrent(void) {
    AudioObjectID device = DefaultDevice(NO);
    if (device == kAudioObjectUnknown) return -1;
    float volume = -1;
    if (HasVirtualMainVolume(device)) {
        AudioObjectPropertyAddress address = {StringSelector(CFSTR("VirtualMainVolume")),
                                              kAudioObjectPropertyScopeOutput,
                                              kAudioObjectPropertyElementMain};
        UInt32 size = sizeof(Float32);
        if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &volume) == noErr) return volume;
        volume = -1;
    }
    UInt32 size = sizeof(Float32);
    if (ReadAudioProperty(device, kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeOutput,
                          kAudioObjectPropertyElementMain, &volume, size))
        return volume;
    return -1;
}

static void VolumeSetScalar(AudioObjectID device, AudioObjectPropertyElement element, float value) {
    AudioObjectPropertyAddress address = {kAudioDevicePropertyVolumeScalar,
                                          kAudioDevicePropertyScopeOutput, element};
    Float32 scalar = value;
    if (AudioObjectHasProperty(device, &address))
        AudioObjectSetPropertyData(device, &address, 0, NULL, sizeof(scalar), &scalar);
}

static void VolumeSet(float value) {
    AudioObjectID device = DefaultDevice(NO);
    if (device == kAudioObjectUnknown) return;
    float clamped = MAX(0, MIN(1, value));
    OutputSetMuted(NO);

    if (HasVirtualMainVolume(device)) {
        AudioObjectPropertyAddress address = {StringSelector(CFSTR("VirtualMainVolume")),
                                              kAudioObjectPropertyScopeOutput,
                                              kAudioObjectPropertyElementMain};
        Float32 volume = clamped;
        AudioObjectSetPropertyData(device, &address, 0, NULL, sizeof(volume), &volume);
        return;
    }

    VolumeSetScalar(device, kAudioObjectPropertyElementMain, clamped);
    for (AudioObjectPropertyElement element = 1; element <= 4; element++)
        VolumeSetScalar(device, element, clamped);
}

static BOOL OutputIsMuted(void) {
    AudioObjectID device = DefaultDevice(NO);
    if (device == kAudioObjectUnknown) return NO;
    UInt32 muted = 0;
    if (!ReadAudioProperty(device, kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput,
                           kAudioObjectPropertyElementMain, &muted, sizeof(muted)))
        return NO;
    return muted != 0;
}

static void OutputSetMuted(BOOL muted) {
    AudioObjectID device = DefaultDevice(NO);
    if (device == kAudioObjectUnknown) return;
    UInt32 value = muted ? 1 : 0;
    WriteAudioProperty(device, kAudioDevicePropertyMute, kAudioDevicePropertyScopeOutput,
                       kAudioObjectPropertyElementMain, &value, sizeof(value));
    if (muted) {
        Float32 zero = 0;
        AudioObjectPropertyAddress address = {StringSelector(CFSTR("VirtualMainVolume")),
                                              kAudioObjectPropertyScopeOutput, kAudioObjectPropertyElementMain};
        if (AudioObjectHasProperty(device, &address))
            AudioObjectSetPropertyData(device, &address, 0, NULL, sizeof(zero), &zero);
        VolumeSetScalar(device, kAudioObjectPropertyElementMain, 0);
    }
}

static BOOL InputIsMuted(void) {
    AudioObjectID device = DefaultDevice(YES);
    if (device == kAudioObjectUnknown) return NO;
    UInt32 muted = 0;
    if (!ReadAudioProperty(device, kAudioDevicePropertyMute, kAudioDevicePropertyScopeInput,
                           kAudioObjectPropertyElementMain, &muted, sizeof(muted)))
        return NO;
    return muted != 0;
}

static void InputSetMuted(BOOL muted) {
    AudioObjectID device = DefaultDevice(YES);
    if (device == kAudioObjectUnknown) return;
    UInt32 value = muted ? 1 : 0;
    WriteAudioProperty(device, kAudioDevicePropertyMute, kAudioDevicePropertyScopeInput,
                       kAudioObjectPropertyElementMain, &value, sizeof(value));
}

static float InputVolume(void) {
    AudioObjectID device = DefaultDevice(YES);
    if (device == kAudioObjectUnknown) return -1;
    Float32 volume = 0;
    if (!ReadAudioProperty(device, kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput,
                           kAudioObjectPropertyElementMain, &volume, sizeof(volume)))
        return 1;
    return MAX(0, MIN(1, volume));
}

static void InputVolumeSet(float value) {
    AudioObjectID device = DefaultDevice(YES);
    if (device == kAudioObjectUnknown) return;
    Float32 volume = MAX(0, MIN(1, value));
    WriteAudioProperty(device, kAudioDevicePropertyVolumeScalar, kAudioDevicePropertyScopeInput,
                       kAudioObjectPropertyElementMain, &volume, sizeof(volume));
}

static NSArray<NSDictionary *> *ListDevices(void) {
    NSMutableArray *result = [NSMutableArray array];
    AudioObjectPropertyAddress address = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal,
                                          kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    if (!AudioObjectHasProperty(kAudioObjectSystemObject, &address)) return result;
    if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, NULL, &size) != noErr)
        return result;

    UInt32 count = size / sizeof(AudioObjectID);
    AudioObjectID *devices = calloc(count, sizeof(AudioObjectID));
    if (!devices) return result;
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, devices) == noErr) {
        for (UInt32 i = 0; i < count; i++) {
            AudioObjectID device = devices[i];
            NSString *name = DeviceName(device);
            BOOL isInput = DeviceChannelCount(device, YES) > 0;
            BOOL isOutput = DeviceChannelCount(device, NO) > 0;
            for (int side = 0; side < 2; side++) {
                BOOL input = side == 0;
                if (input ? !isInput : !isOutput) continue;
                if (input == isOutput && DeviceChannelCount(device, input) == 0) continue;
                [result addObject:@{
                    @"id": @(device),
                    @"uid": DeviceUID(device),
                    @"name": name,
                    @"input": @(input),
                    @"isDefault": @(device == DefaultDevice(input)),
                    @"inUse": @(DeviceIsRunning(device, input)),
                }];
            }
        }
    }
    free(devices);
    return result;
}

static BOOL SetDefaultDevice(AudioObjectID device, BOOL isInput) {
    AudioObjectPropertySelector selector = isInput ? kAudioHardwarePropertyDefaultInputDevice
                                                  : kAudioHardwarePropertyDefaultOutputDevice;
    AudioObjectPropertyAddress address = {selector, kAudioObjectPropertyScopeGlobal,
                                          kAudioObjectPropertyElementMain};
    // CoreAudio only lets a process become the owner of the default device when
    // it participates in the audio hardware process list.
    AudioObjectPropertyAddress processList = {kAudioHardwarePropertyProcessObjectList,
                                              kAudioObjectPropertyScopeGlobal,
                                              kAudioObjectPropertyElementMain};
    if (AudioObjectHasProperty(kAudioObjectSystemObject, &processList)) {
        UInt32 listSize = 0;
        if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &processList, 0, NULL, &listSize) == noErr &&
            listSize > 0) {
            UInt32 *ids = calloc(listSize / sizeof(UInt32) + 2, sizeof(UInt32));
            if (ids) {
                AudioObjectID self = (AudioObjectID)getpid();
                UInt32 pidCount = 1;
                ids[0] = (UInt32)self;
                UInt32 total = listSize + sizeof(UInt32);
                AudioObjectSetPropertyData(kAudioObjectSystemObject, &processList, 0, NULL, total, ids);
                free(ids);
                (void)pidCount;
            }
        }
    }
    return AudioObjectSetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, sizeof(device), &device) == noErr;
}

#pragma mark - Shared command centre

// `sendMPRemoteCommandEvent:` exists at runtime but is missing from the SDK.
@interface MPRemoteCommand (NotchHelperForwarding)
- (void)sendMPRemoteCommandEvent:(nullable MPRemoteCommandEvent *)event;
@end

static void SendRemote(MPRemoteCommand *command) {
    if (![command respondsToSelector:@selector(sendMPRemoteCommandEvent:)]) {
        Emit(@{@"event": @"error", @"message": @"remote command forwarding unavailable"});
        return;
    }
    [command sendMPRemoteCommandEvent:nil];
}

@interface SharedCommandCenter : NSObject
+ (instancetype)shared;
@property(nonatomic, copy) void (^onCommand)(NSString *command, NSDictionary *args);
- (void)bindRemoteCommands;
- (void)play;
- (void)pause;
- (void)togglePlayPause;
- (void)next;
- (void)previous;
- (void)seek:(double)seconds;
@end

@implementation SharedCommandCenter

+ (instancetype)shared {
    static SharedCommandCenter *shared;
    static dispatch_once_t token;
    dispatch_once(&token, ^{ shared = [SharedCommandCenter new]; });
    return shared;
}

- (MPRemoteCommandHandlerStatus (^)(MPRemoteCommandEvent *))handlerForKey:(NSString *)key {
    return ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
        // The system routed a media key to us; tell the app which one it was.
        Emit(@{@"event": @"mediaKey", @"key": key});
        return MPRemoteCommandHandlerStatusSuccess;
    };
}

- (MPRemoteCommandHandlerStatus (^)(MPRemoteCommandEvent *))handlerForValueEvent {
    return ^MPRemoteCommandHandlerStatus(MPRemoteCommandEvent *event) {
        if ([event isKindOfClass:[MPChangePlaybackPositionCommandEvent class]]) {
            MPChangePlaybackPositionCommandEvent *position = (MPChangePlaybackPositionCommandEvent *)event;
            Emit(@{@"event": @"mediaKey", @"key": @"seek", @"value": @(position.positionTime)});
        } else if ([event isKindOfClass:[MPChangePlaybackRateCommandEvent class]]) {
            MPChangePlaybackRateCommandEvent *rate = (MPChangePlaybackRateCommandEvent *)event;
            Emit(@{@"event": @"mediaKey", @"key": rate.playbackRate > 0 ? @"play" : @"pause"});
        }
        return MPRemoteCommandHandlerStatusSuccess;
    };
}

- (void)bindRemoteCommands {
    MPRemoteCommandCenter *center = [MPRemoteCommandCenter sharedCommandCenter];
    MPRemoteCommandHandlerStatus (^valueHandler)(MPRemoteCommandEvent *) = [self handlerForValueEvent];

    [[center playCommand] addTargetWithHandler:[self handlerForKey:@"play"]];
    [[center pauseCommand] addTargetWithHandler:[self handlerForKey:@"pause"]];
    [[center togglePlayPauseCommand] addTargetWithHandler:[self handlerForKey:@"togglePlayPause"]];
    [[center nextTrackCommand] addTargetWithHandler:[self handlerForKey:@"next"]];
    [[center previousTrackCommand] addTargetWithHandler:[self handlerForKey:@"previous"]];
    [[center changePlaybackPositionCommand] addTargetWithHandler:valueHandler];
    [[center changePlaybackRateCommand] addTargetWithHandler:valueHandler];
}

- (void)play { SendRemote([MPRemoteCommandCenter sharedCommandCenter].playCommand); }
- (void)pause { SendRemote([MPRemoteCommandCenter sharedCommandCenter].pauseCommand); }
- (void)togglePlayPause { SendRemote([MPRemoteCommandCenter sharedCommandCenter].togglePlayPauseCommand); }
- (void)next { SendRemote([MPRemoteCommandCenter sharedCommandCenter].nextTrackCommand); }
- (void)previous { SendRemote([MPRemoteCommandCenter sharedCommandCenter].previousTrackCommand); }

- (void)seek:(double)seconds {
    // `initWithTimeInterval:` is not in the SDK but is present at runtime.
    SEL init = NSSelectorFromString(@"initWithTimeInterval:");
    if (![[MPChangePlaybackPositionCommandEvent alloc] respondsToSelector:init]) return;
    id event = ((id (*)(id, SEL, double))objc_msgSend)([MPChangePlaybackPositionCommandEvent class], init, seconds);
    if (![event isKindOfClass:[MPRemoteCommandEvent class]]) return;
    MPRemoteCommand *command = [MPRemoteCommandCenter sharedCommandCenter].changePlaybackPositionCommand;
    if ([command respondsToSelector:@selector(sendMPRemoteCommandEvent:)]) [command sendMPRemoteCommandEvent:event];
}

@end

#pragma mark - Now playing

#pragma mark - Bluetooth, HID batteries and the system battery

/// Battery percentages reported by the HID layer, keyed by Bluetooth address.
static NSDictionary<NSString *, NSDictionary *> *HIDBatteryByAddress(void) {
    NSMutableDictionary<NSString *, NSDictionary *> *result = [NSMutableDictionary dictionary];
    CFMutableDictionaryRef matching = IOServiceMatching("IOHIDDevice");
    io_iterator_t iterator = IO_OBJECT_NULL;
    if (!matching || IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) != KERN_SUCCESS) {
        if (matching) CFRelease(matching);
        return result;
    }

    io_service_t service;
    while ((service = IOIteratorNext(iterator))) {
        IOHIDDeviceRef device = IOHIDDeviceCreate(kCFAllocatorDefault, service);
        if (device) {
            CFTypeRef level = IOHIDDeviceGetProperty(device, CFSTR("BatteryLevel"));
            // AirPods and Magic devices only carry the property while they are on.
            if (level && CFGetTypeID(level) == CFNumberGetTypeID()) {
                int percent = 0;
                CFNumberGetValue((CFNumberRef)level, kCFNumberIntType, &percent);

                NSString *address = nil;
                CFTypeRef raw = IOHIDDeviceGetProperty(device, CFSTR("DeviceAddress"));
                if (raw && CFGetTypeID(raw) == CFDataGetTypeID() && CFDataGetLength((CFDataRef)raw) >= 6) {
                    const UInt8 *bytes = CFDataGetBytePtr((CFDataRef)raw);
                    address = [NSString stringWithFormat:@"%02X-%02X-%02X-%02X-%02X-%02X",
                                                       bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]];
                }
                if (address) {
                    CFTypeRef product = IOHIDDeviceGetProperty(device, CFSTR("DeviceProduct"));
                    NSString *name = nil;
                    if (product && CFGetTypeID(product) == CFStringGetTypeID()) {
                        name = (__bridge NSString *)product;
                    }
                    int pairing = 0;
                    CFTypeRef status = IOHIDDeviceGetProperty(device, CFSTR("DeviceStatusPairing"));
                    if (status && CFGetTypeID(status) == CFNumberGetTypeID()) {
                        CFNumberGetValue((CFNumberRef)status, kCFNumberIntType, &pairing);
                    }
                    result[address] = @{
                        @"battery": @(MAX(0, MIN(1, percent / 100.0))),
                        @"name": name ?: @"",
                        // AirPods report 2 while they sit in the case charging.
                        @"charging": @(pairing == 2),
                    };
                }
            }
            CFRelease(device);
        }
        IOObjectRelease(service);
    }
    IOObjectRelease(iterator);
    return result;
}

static NSString *FriendlyBluetoothName(NSString *name) {
    if (!name.length) return @"Bluetooth device";
    return [name stringByReplacingOccurrencesOfString:@" (" withString:@" · "];
}

static NSArray<NSDictionary *> *BluetoothDevices(void) {
    NSDictionary<NSString *, NSDictionary *> *batteries = HIDBatteryByAddress();
    NSMutableArray *devices = [NSMutableArray array];
    for (IOBluetoothDevice *device in [IOBluetoothDevice pairedDevices]) {
        NSString *address = [device.addressString uppercaseString];
        NSDictionary *battery = batteries[address];
        [devices addObject:@{
            @"address": address ?: @"",
            @"name": FriendlyBluetoothName(device.name),
            @"connected": @([device isConnected]),
            @"battery": battery[@"battery"] ?: @(-1),
            @"charging": battery[@"charging"] ?: @NO,
        }];
    }
    return devices;
}

// The IOPS keys are C string macros, so they need wrapping to be dictionary keys.
static double PowerNumber(CFDictionaryRef description, CFStringRef key) {
    CFTypeRef value = CFDictionaryGetValue(description, key);
    double number = -1;
    if (value && CFGetTypeID(value) == CFNumberGetTypeID()) {
        CFNumberGetValue((CFNumberRef)value, kCFNumberDoubleType, &number);
    }
    return number;
}

static BOOL PowerBool(CFDictionaryRef description, CFStringRef key) {
    CFTypeRef value = CFDictionaryGetValue(description, key);
    return value ? [(__bridge NSNumber *)value boolValue] : NO;
}

static NSDictionary *SystemBattery(void) {
    CFTypeRef snapshot = IOPSCopyPowerSourcesInfo();
    if (!snapshot) return nil;
    CFArrayRef sources = IOPSCopyPowerSourcesList(snapshot);
    double level = -1;
    BOOL charging = NO;
    int minutes = -1;
    double bestCapacity = 0;

    for (CFIndex i = 0; sources && i < CFArrayGetCount(sources); i++) {
        CFTypeRef source = CFArrayGetValueAtIndex(sources, i);
        CFDictionaryRef description = IOPSGetPowerSourceDescription(snapshot, source);
        if (!description) continue;

        double capacity = PowerNumber(description, CFSTR(kIOPSCurrentCapacityKey));
        double maximum = PowerNumber(description, CFSTR(kIOPSMaxCapacityKey));
        if (capacity < 0) continue;
        if (maximum <= 0) maximum = 100;  // some sources only report a percentage
        if (maximum <= bestCapacity) continue;
        bestCapacity = maximum;

        level = MAX(0, MIN(1, capacity / maximum));
        charging = PowerBool(description, CFSTR(kIOPSIsChargingKey));
        double time = PowerNumber(description, CFSTR(kIOPSTimeToEmptyKey));
        minutes = time > 0 ? (int)time : -1;
    }
    if (sources) CFRelease(sources);
    CFRelease(snapshot);
if (level < 0) return nil;
     return @{@"level": @(level), @"charging": @(charging), @"minutes": @(minutes), @"full": @(level >= 1)};
}

@interface NSImage (NotchHelper)
- (NSImage *)resizedToFit:(CGFloat)maxDimension;
@end

static NSString *ArtworkDataURL(void) {
    MPMediaItemArtwork *artwork = [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo[MPMediaItemPropertyArtwork];
    if (!artwork) return nil;
    NSImage *image = [artwork imageWithSize:CGSizeMake(160, 160)];
    if (!image) return nil;
    NSImage *scaled = [image resizedToFit:160];
    CGImageRef cgImage = [scaled CGImageForProposedRect:NULL context:nil hints:nil];
    if (!cgImage) return nil;
    NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:cgImage];
    NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png.length) return nil;
    return [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]];
}

@interface NotchHelper : NSObject
@property(nonatomic, copy) NSString *bluetoothSignature;
@property(nonatomic, copy) NSString *inputSignature;
@property(nonatomic, copy) NSString *devicesSignature;
@property(nonatomic, copy) NSString *volumeSignature;
@property(nonatomic) BOOL lastAirDropTransferring;
@property(nonatomic) BOOL lastCallState;
@end

@implementation NotchHelper

+ (instancetype)shared {
    static NotchHelper *shared;
    static dispatch_once_t token;
    dispatch_once(&token, ^{ shared = [NotchHelper new]; });
    return shared;
}

- (void)publishNowPlaying {
    NSDictionary *info = [MPNowPlayingInfoCenter defaultCenter].nowPlayingInfo ?: @{};
    NSMutableDictionary *payload = [@{@"event": @"nowPlaying"} mutableCopy];
    payload[@"empty"] = @(info.count == 0);
    payload[@"state"] = @([MPNowPlayingInfoCenter defaultCenter].playbackState);
    payload[@"title"] = info[MPMediaItemPropertyTitle] ?: @"";
    payload[@"artist"] = info[MPMediaItemPropertyArtist] ?: @"";
    payload[@"album"] = info[MPMediaItemPropertyAlbumTitle] ?: @"";
    payload[@"duration"] = info[MPMediaItemPropertyPlaybackDuration] ?: @0;
    payload[@"elapsed"] = info[MPNowPlayingInfoPropertyElapsedPlaybackTime] ?: @0;
    payload[@"rate"] = info[MPNowPlayingInfoPropertyPlaybackRate] ?: @0;
    payload[@"source"] = info[MPNowPlayingInfoPropertyExternalContentIdentifier] ?: @"";
    NSString *artwork = ArtworkDataURL();
    if (artwork) payload[@"artworkData"] = artwork;
    Emit(payload);
}

- (void)publishDevices {
    NSMutableArray *activeInputs = [NSMutableArray array];
    for (NSDictionary *device in ListDevices()) {
        if ([device[@"input"] boolValue] && [device[@"inUse"] boolValue]) {
            [activeInputs addObject:device[@"name"]];
        }
    }
    NSString *signature = [NSString stringWithFormat:@"%@|%d|%d|%.4f|%.4f|%@",
        activeInputs, DefaultDevice(NO), DefaultDevice(YES),
        VolumeCurrent(), InputVolume(), OutputIsMuted() ? @"1" : @"0"];
    if ([signature isEqualToString:self.devicesSignature]) return;
    self.devicesSignature = signature;

    Emit(@{
        @"event": @"devices",
        @"output": @(DefaultDevice(NO)),
        @"input": @(DefaultDevice(YES)),
        @"devices": ListDevices(),
        @"muted": @(OutputIsMuted()),
        @"inputMuted": @(InputIsMuted()),
        @"volume": @(VolumeCurrent()),
        @"inputVolume": @(InputVolume()),
        @"activeInputs": activeInputs,
    });
}

- (void)publishBluetooth {
    NSArray *devices = BluetoothDevices();
    self.bluetoothSignature = [devices description];
    Emit(@{@"event": @"bluetooth", @"devices": devices});
}

- (void)publishBluetoothIfChanged {
    NSArray *devices = BluetoothDevices();
    if ([[devices description] isEqualToString:self.bluetoothSignature]) return;
    [self publishBluetooth];
    [self publishDevices];
}

- (void)publishAirDropIfChanged {
    BOOL now = [self isAirDropTransferring];
    if (now == self.lastAirDropTransferring) return;
    self.lastAirDropTransferring = now;
    Emit(@{@"event": @"airdrop", @"transferring": @(now)});
}

- (BOOL)isAirDropTransferring {
    // Check for the awdl0 interface via getifaddrs.
    struct ifaddrs *addrs = NULL;
    if (getifaddrs(&addrs) != 0) return NO;
    BOOL result = NO;
    struct ifaddrs *walk = addrs;
    while (walk) {
        if (walk->ifa_addr && walk->ifa_addr->sa_family == AF_LINK) {
            if (strcmp(walk->ifa_name, "awdl0") == 0) {
                result = YES;
                break;
            }
        }
        walk = walk->ifa_next;
    }
    freeifaddrs(addrs);
    return result;
}

- (BOOL)isFaceTimeActive {
    for (NSRunningApplication *app in [[NSWorkspace sharedWorkspace] runningApplications]) {
        if ([app.bundleIdentifier isEqualToString:@"com.apple.FaceTime"] && app.isActive) return YES;
    }
    return NO;
}

- (void)publishCall {
    BOOL hasCall = [self isFaceTimeActive];
    if (hasCall != self.lastCallState) {
        self.lastCallState = hasCall;
        Emit(@{@"event": @"call", @"incoming": @(hasCall)});
    }
}

- (void)publishBattery {
    NSDictionary *battery = SystemBattery();
    if (!battery) return;
    Emit(@{@"event": @"battery", @"battery": battery});
}

- (void)publishVolume {
    float value = MAX(0, VolumeCurrent());
    BOOL muted = OutputIsMuted();
    NSString *signature = [NSString stringWithFormat:@"%.4f|%d", value, muted];
    if ([signature isEqualToString:self.volumeSignature]) return;
    self.volumeSignature = signature;
    Emit(@{@"event": @"volume", @"value": @(value), @"muted": @(muted)});
}

- (void)publishInput {
    NSDictionary *payload = @{
        @"event": @"input",
        @"muted": @(InputIsMuted()),
        @"volume": @(MAX(0, InputVolume())),
        @"active": [self activeInputNames],
    };
    NSString *signature = [payload description];
    if ([signature isEqualToString:self.inputSignature]) return;
    self.inputSignature = signature;
    Emit(payload);
}

- (NSArray<NSString *> *)activeInputNames {
    NSMutableArray *names = [NSMutableArray array];
    for (NSDictionary *device in ListDevices()) {
        if ([device[@"input"] boolValue] && [device[@"inUse"] boolValue]) [names addObject:device[@"name"]];
    }
    return names;
}

- (void)observeAudioChanges {
    AudioObjectPropertyAddress output = {kAudioHardwarePropertyDefaultOutputDevice,
                                         kAudioObjectPropertyScopeGlobal,
                                         kAudioObjectPropertyElementMain};
    AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &output, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0),
                                        ^(UInt32 inThisInstance, const AudioObjectPropertyAddress *inAddress) {
        (void)inThisInstance;
        (void)inAddress;
        dispatch_async(dispatch_get_main_queue(), ^{ [[NotchHelper shared] publishDevices]; });
    });

    AudioObjectPropertyAddress input = {kAudioHardwarePropertyDefaultInputDevice,
                                        kAudioObjectPropertyScopeGlobal,
                                        kAudioObjectPropertyElementMain};
    AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &input, dispatch_get_global_queue(QOS_CLASS_UTILITY, 0),
                                        ^(UInt32 inThisInstance, const AudioObjectPropertyAddress *inAddress) {
        (void)inThisInstance;
        (void)inAddress;
        dispatch_async(dispatch_get_main_queue(), ^{ [[NotchHelper shared] publishInput]; });
    });

    // Polls the "is a microphone in use" flag, which is what powers the
    // "meeting" indicator. CoreAudio has no notification for it.
    [NSTimer scheduledTimerWithTimeInterval:2.0 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        [[NotchHelper shared] publishInput];
    }];
}

- (void)start {
    __weak typeof(self) weakSelf = self;
    [SharedCommandCenter shared].onCommand = ^(NSString *command, NSDictionary *args) {
        __strong typeof(weakSelf) self = weakSelf;
        if (!self) return;
        if ([command isEqualToString:@"play"]) [[SharedCommandCenter shared] play];
        else if ([command isEqualToString:@"pause"]) [[SharedCommandCenter shared] pause];
        else if ([command isEqualToString:@"togglePlayPause"]) [[SharedCommandCenter shared] togglePlayPause];
        else if ([command isEqualToString:@"next"]) [[SharedCommandCenter shared] next];
        else if ([command isEqualToString:@"previous"]) [[SharedCommandCenter shared] previous];
        else if ([command isEqualToString:@"seek"]) [[SharedCommandCenter shared] seek:[args[@"value"] doubleValue]];
        [self publishNowPlaying];
    };
    [[SharedCommandCenter shared] bindRemoteCommands];

    MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
    [center addObserver:self forKeyPath:@"nowPlayingInfo" options:NSKeyValueObservingOptionNew context:NULL];
    [center addObserver:self forKeyPath:@"playbackState" options:NSKeyValueObservingOptionNew context:NULL];

    [self observeAudioChanges];
[self publishNowPlaying];
     [self publishDevices];
     [self publishInput];
     [self publishBluetooth];
     [self publishBattery];
     self.volumeSignature = @"";
     [self publishVolume];
     self.lastAirDropTransferring = [self isAirDropTransferring];
     self.lastCallState = [self isFaceTimeActive];

    // CoreAudio has no notification when the volume changes somewhere else (the
    // volume keys, Control Center, another app), so watch it and stay quiet
    // unless it actually moved.
    [NSTimer scheduledTimerWithTimeInterval:0.7 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        [[NotchHelper shared] publishVolume];
    }];

    // Battery and Bluetooth have no notification worth relying on, so poll.
[NSTimer scheduledTimerWithTimeInterval:2.0 repeats:YES block:^(NSTimer *timer) {
         (void)timer;
         [[NotchHelper shared] publishBattery];
     }];
[NSTimer scheduledTimerWithTimeInterval:2.5 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        [[NotchHelper shared] publishBluetoothIfChanged];
    }];
    [NSTimer scheduledTimerWithTimeInterval:2.0 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        [[NotchHelper shared] publishAirDropIfChanged];
    }];
    [NSTimer scheduledTimerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *timer) {
        (void)timer;
        [[NotchHelper shared] publishCall];
    }];
}

- (void)observeValueForKeyPath:(NSString *)keyPath ofObject:(id)object change:(NSDictionary *)change context:(void *)context {
    (void)keyPath; (void)object; (void)change; (void)context;
    [self publishNowPlaying];
}

- (void)handleCommand:(NSString *)command args:(NSDictionary *)args {
    if ([command isEqualToString:@"play"] || [command isEqualToString:@"pause"] ||
        [command isEqualToString:@"togglePlayPause"] || [command isEqualToString:@"next"] ||
        [command isEqualToString:@"previous"] || [command isEqualToString:@"seek"]) {
        [SharedCommandCenter shared].onCommand(command, args);
        return;
    }
    if ([command isEqualToString:@"volume"]) {
        VolumeSet((float)[args[@"value"] doubleValue]);
        [self publishVolume];
    } else if ([command isEqualToString:@"nudgeVolume"]) {
        OutputSetMuted(NO);
        float current = VolumeCurrent();
        VolumeSet(current < 0 ? (float)[args[@"value"] doubleValue] : current + (float)[args[@"value"] doubleValue]);
        [self publishVolume];
    } else if ([command isEqualToString:@"mute"]) {
        OutputSetMuted(!OutputIsMuted());
        [self publishVolume];
    } else if ([command isEqualToString:@"setOutput"] || [command isEqualToString:@"setInput"]) {
        SetDefaultDevice((AudioObjectID)[args[@"id"] unsignedIntValue], [command isEqualToString:@"setInput"]);
        [self publishDevices];
        [self publishInput];
    } else if ([command isEqualToString:@"muteInput"]) {
        InputSetMuted(!InputIsMuted());
        [self publishInput];
    } else if ([command isEqualToString:@"inputVolume"]) {
        InputVolumeSet((float)[args[@"value"] doubleValue]);
        [self publishInput];
    } else if ([command isEqualToString:@"devices"]) {
        [self publishDevices];
        [self publishInput];
    } else if ([command isEqualToString:@"input"]) {
        [self publishInput];
    } else if ([command isEqualToString:@"bluetooth"]) {
        [self publishBluetooth];
    } else if ([command isEqualToString:@"battery"]) {
        [self publishBattery];
    } else if ([command isEqualToString:@"btConnect"] || [command isEqualToString:@"btDisconnect"]) {
        NSString *address = args[@"address"];
        for (IOBluetoothDevice *device in [IOBluetoothDevice pairedDevices]) {
            if (![device.addressString isEqualToString:address]) continue;
            if ([command isEqualToString:@"btConnect"]) [device openConnection];
            else [device closeConnection];
            break;
        }
        // The connection takes a moment; report again once it settled.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.2 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [[NotchHelper shared] publishBluetooth];
            [[NotchHelper shared] publishDevices];
        });
    } else if ([command isEqualToString:@"volumeRaw"]) {
        Emit(@{@"event": @"volumeRaw", @"value": @(VolumeCurrent()), @"muted": @(OutputIsMuted())});
    } else if ([command isEqualToString:@"ping"]) {
        Emit(@{@"event": @"pong", @"id": args[@"id"] ?: @0});
    } else if ([command isEqualToString:@"capabilities"]) {
        Emit(@{@"event": @"capabilities", @"capabilities": [self capabilities]});
    } else if ([command isEqualToString:@"quit"]) {
        exit(0);
    } else {
        Emit(@{@"event": @"error", @"message": [@"unknown command " stringByAppendingString:command]});
    }
}

- (NSDictionary *)capabilities {
     return @{
         @"nowPlaying": @YES,
         @"volume": @(VolumeIsAvailable()),
         @"pid": @(getpid()),
         @"airdrop": @YES,
         @"call": @YES,
     };
 }

@end

#pragma mark - Main

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        BOOL probe = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--probe") == 0) probe = YES;
        }

        Emit(@{@"event": @"hello", @"capabilities": [[NotchHelper shared] capabilities]});

        if (probe) {
            [[NotchHelper shared] publishNowPlaying];
            [[NotchHelper shared] publishDevices];
            [[NotchHelper shared] publishInput];
            [[NotchHelper shared] publishBluetooth];
            [[NotchHelper shared] publishBattery];
            return 0;
        }

        [[NotchHelper shared] start];

        // stdin pump: one JSON object per line.
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
            char buffer[8192];
            NSMutableString *pending = [NSMutableString string];
            while (YES) {
                // read() (not fread) so a partial line is picked up immediately.
                ssize_t bytesRead = read(fileno(stdin), buffer, sizeof(buffer));
                if (bytesRead <= 0) {
                    if (bytesRead < 0 && errno == EINTR) continue;
                    break;  // stdin closed
                }
                NSString *chunk = [[NSString alloc] initWithBytes:buffer
                                                          length:(NSUInteger)bytesRead
                                                        encoding:NSUTF8StringEncoding];
                if (!chunk) continue;
                [pending appendString:chunk];
                NSArray<NSString *> *lines = [pending componentsSeparatedByString:@"\n"];
                pending = [lines.lastObject mutableCopy];
                for (NSUInteger i = 0; i + 1 < lines.count; i++) {
                    NSString *line = lines[i];
                    if (line.length == 0) continue;
                    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
                    NSDictionary *object = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                    if (![object isKindOfClass:[NSDictionary class]]) continue;
                    NSString *command = object[@"cmd"];
                    if (![command isKindOfClass:[NSString class]]) continue;
                    dispatch_async(dispatch_get_main_queue(), ^{
                        [[NotchHelper shared] handleCommand:command args:object];
                    });
                }
            }
            exit(0);
        });

        [[NSRunLoop mainRunLoop] run];
    }
    return 0;
}
