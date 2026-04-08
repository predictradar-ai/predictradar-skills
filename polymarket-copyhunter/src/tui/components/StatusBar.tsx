/**
 * CopyHunter - StatusBar Component
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { FollowMode } from '../../core/types.js';
import type { WatchEngineStats } from '../../watch/index.js';
import type { FollowDisplayStatus, FollowEngineStats } from '../../follow/index.js';
import type { WatchDisplayStatus } from '../../watch/index.js';

interface StatusBarProps {
  mode: FollowMode;
  isWatching: boolean;
  watchStats: WatchEngineStats;
  followStats: FollowEngineStats;
  watchStatus: WatchDisplayStatus;
  followStatus: FollowDisplayStatus;
  watchSourceLabel: string;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  mode,
  isWatching,
  watchStats,
  followStats,
  watchStatus,
  followStatus,
  watchSourceLabel,
}) => {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="gray">{'─'.repeat(80)}</Text>
      </Box>
      <Box>
        <Text color="gray">[w]</Text>
        <Text> {isWatching ? 'Stop' : 'Start'} Watch </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">[p]</Text>
        <Text> Poll </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">[1-3]</Text>
        <Text> Tabs </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">[q]</Text>
        <Text> Quit </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">State:</Text>
        <Text color={watchStatus.color}> {watchStatus.label} </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">Follow:</Text>
        <Text color={followStatus.color}> {followStatus.label} </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">Polls:</Text>
        <Text color="cyan"> {watchStats.pollCount} </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">Events:</Text>
        <Text color="cyan"> {watchStats.eventsSaved} </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">Followed:</Text>
        <Text color="green"> {followStats.eventsFollowed} </Text>
        <Text color="gray">│ </Text>

        <Text color="gray">$</Text>
        <Text color="yellow">{followStats.totalAmountUsd.toFixed(0)}</Text>
      </Box>

      {(watchStatus.detail
        || watchStatus.dependencySummary
        || watchStats.consecutiveErrors > 0
        || followStatus.detail
        || (watchStats.currentLeaderAddress && watchStats.currentLeaderCatchUpBudget > 0)) && (
        <Box>
          <Text color="gray">Watch:</Text>
          {watchStatus.detail ? <Text color={watchStatus.color}> {watchStatus.detail}</Text> : null}
          {watchStats.currentLeaderAddress && watchStats.currentLeaderCatchUpBudget > 0 ? (
            <Text color={watchStats.currentLeaderCatchUpMode === 'high_activity' ? 'yellow' : 'cyan'}>
              {` │ Catch-up ${watchStats.currentLeaderCatchUpMode} ${watchStats.currentLeaderPass}/${watchStats.currentLeaderCatchUpPassLimit} b${watchStats.currentLeaderCatchUpBudget}`}
            </Text>
          ) : null}
          {watchStatus.dependencySummary ? <Text color="yellow">{` │ Deps ${watchStatus.dependencySummary}`}</Text> : null}
          {watchStats.consecutiveErrors > 0 ? (
            <Text color="red">{` │ Errors ${watchStats.consecutiveErrors}`}</Text>
          ) : null}
          {followStatus.detail ? (
            <Text color={followStatus.color}>{` │ Follow ${followStatus.detail}`}</Text>
          ) : null}
          <Text color="gray">{` │ ${watchSourceLabel}`}</Text>
        </Box>
      )}
    </Box>
  );
};
