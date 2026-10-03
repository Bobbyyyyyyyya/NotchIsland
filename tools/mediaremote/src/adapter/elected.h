// Copyright (c) 2025 Jonas van den Berg
// This file is licensed under the BSD 3-Clause License.

#ifndef MEDIAREMOTEADAPTER_ADAPTER_ELECTED_H
#define MEDIAREMOTEADAPTER_ADAPTER_ELECTED_H

#import <Foundation/Foundation.h>

// MediaRemote only ever reports now playing information for a single "front"
// application, which is the one that registered most recently rather than the
// one that is actually playing. On a Mac that runs a browser next to a media
// player this makes the browser steal the slot for minutes at a time.
//
// This resolves the now playing information of the client that should be
// presented instead, using the per client accessors of the MediaRemote
// framework. The result dictionary contains:
//   "info"                            raw MediaRemote info dictionary
//   "processIdentifier"               NSNumber
//   "bundleIdentifier"                NSString or NSNull
//   "parentApplicationBundleIdentifier" NSString or NSNull
//   "playing"                         NSNumber (BOOL)
//   "state"                           NSNumber (MRPlaybackState)
//
// The completion receives nil when no client could be resolved, in which case
// the caller falls back to the plain "front application" accessors.
//
// `enabled` turns the election off, which is what the adapter's own test mode
// needs: it publishes a synthetic client that only becomes visible as the
// front application.
//
// When `requireTitle` is set, clients without a non empty title are ignored so
// that helper processes which only register remote commands never win. A page
// that plays sound usually reports no title at all, so when nothing wins with
// one the election falls back to the best client without a title instead of
// leaving the caller with the front application, which is what made the player
// fold and unfold while the same sound kept playing.
//
// `incumbentBundle` and `incumbentParent` name the client that is on screen
// right now. Several clients of one application report the same sound, and the
// bonus they get keeps the player parked on the one it already shows rather
// than re-electing every poll.
void MRAResolveNowPlaying(bool enabled, bool requireTitle, NSString *incumbentBundle,
                          NSString *incumbentParent,
                          void (^completion)(NSDictionary *resolved));

#endif // MEDIAREMOTEADAPTER_ADAPTER_ELECTED_H
