/**
 * CopyHunter - Header Component
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { FollowMode } from '../../core/types.js';
import type { WatchDisplayStatus } from '../../watch/index.js';
import type { FollowDisplayStatus } from '../../follow/index.js';

interface HeaderProps {
  mode: FollowMode;
  isWatching: boolean;
  watchStatus: WatchDisplayStatus;
  followStatus: FollowDisplayStatus;
  watchSourceLabel: string;
  notification?: string | null;
}

export const Header: React.FC<HeaderProps> = ({
  mode,
  isWatching,
  watchStatus,
  followStatus,
  watchSourceLabel,
  notification,
}) => {
  const modeColor = {
    shadow: 'cyan',
    live: 'green',
    disabled: 'gray',
  }[mode] as 'cyan' | 'green' | 'gray';

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="yellow">🎯 CopyHunter</Text>
        <Text> │ </Text>
        <Text color={modeColor}>{mode.toUpperCase()}</Text>
        <Text> │ </Text>
        <Text color={isWatching ? 'green' : 'gray'}>
          {isWatching ? '● WATCHING' : '○ IDLE'}
        </Text>
        <Text> │ </Text>
        <Text color={watchStatus.color}>{watchStatus.label}</Text>
        <Text> │ </Text>
        <Text color={followStatus.color}>{followStatus.label}</Text>
        <Text> │ </Text>
        <Text color="gray">{watchSourceLabel}</Text>
        <Text> │ </Text>
        <Text color="gray">{new Date().toLocaleTimeString()}</Text>
      </Box>

      {(watchStatus.detail || watchStatus.dependencySummary || followStatus.detail) && (
        <Box marginTop={0}>
          <Text color={watchStatus.color}>{watchStatus.label}:</Text>
          {watchStatus.detail ? <Text> {watchStatus.detail}</Text> : null}
          {watchStatus.dependencySummary ? (
            <Text color="yellow">{` Deps: ${watchStatus.dependencySummary}`}</Text>
          ) : null}
          {followStatus.detail ? (
            <Text color={followStatus.color}>{` │ Follow ${followStatus.label}: ${followStatus.detail}`}</Text>
          ) : null}
        </Box>
      )}

      {notification && (
        <Box marginTop={0}>
          <Text color="yellow">⚡ {notification}</Text>
        </Box>
      )}
    </Box>
  );
};
