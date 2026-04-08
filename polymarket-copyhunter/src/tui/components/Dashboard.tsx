/**
 * CopyHunter - Dashboard Component
 *
 * Main TUI dashboard with tabs for different views
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { Header } from './Header.js';
import { LeaderTable } from './LeaderTable.js';
import { EventStream } from './EventStream.js';
import { StatusBar } from './StatusBar.js';
import { PositionList } from './PositionList.js';
import { HelpPanel } from './HelpPanel.js';
import { getConfig } from '../../core/config.js';
import { eventBus } from '../../core/events.js';
import { buildFollowDisplayStatus, getFollowEngine } from '../../follow/index.js';
import {
  buildWatchDisplayStatus,
  getWatchEngine,
  getWatchRuntimeStateManager,
  isWatchStatusStale,
  resolveActiveWatchSnapshot,
  type WatchStatusSnapshot,
} from '../../watch/index.js';

type Tab = 'events' | 'leaders' | 'positions' | 'help';

interface DashboardProps {
  refreshInterval?: number;
}

export const Dashboard: React.FC<DashboardProps> = ({ refreshInterval = 5000 }) => {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<Tab>('events');
  const [isWatching, setIsWatching] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(Date.now());
  const [notification, setNotification] = useState<string | null>(null);
  const [runtimePid, setRuntimePid] = useState<number | null>(null);
  const [runtimeSnapshot, setRuntimeSnapshot] = useState<WatchStatusSnapshot | null>(null);
  const [runtimeStale, setRuntimeStale] = useState(false);

  const config = getConfig();
  const watchEngine = getWatchEngine();
  const followEngine = getFollowEngine();
  const runtimeState = getWatchRuntimeStateManager();

  const refreshRuntimeStatus = useCallback(() => {
    const nextPid = runtimeState.cleanupStaleState();
    const nextSnapshot = runtimeState.readStatus();
    setRuntimePid(nextPid);
    setRuntimeSnapshot(nextSnapshot);
    setRuntimeStale(isWatchStatusStale(nextSnapshot, nextPid));
  }, [runtimeState]);

  // Auto-refresh trigger
  useEffect(() => {
    refreshRuntimeStatus();
    const timer = setInterval(() => {
      setLastUpdate(Date.now());
      refreshRuntimeStatus();
    }, refreshInterval);

    return () => clearInterval(timer);
  }, [refreshInterval, refreshRuntimeStatus]);

  // Event listeners
  useEffect(() => {
    const handleTradeNew = ({ event }: any) => {
      setNotification(`New: ${event.eventType} $${event.amountUsd.toFixed(0)} ${(event.marketTitle || '').slice(0, 30)}`);
      setTimeout(() => setNotification(null), 3000);
    };

    const handleFollowExecuted = ({ order }: any) => {
      setNotification(`Followed: $${order.amountUsd?.toFixed(0)} @ ${order.executedPrice?.toFixed(4)}`);
      setTimeout(() => setNotification(null), 3000);
    };

    eventBus.on('trade:new', handleTradeNew);
    eventBus.on('follow:executed', handleFollowExecuted);

    return () => {
      eventBus.off('trade:new', handleTradeNew);
      eventBus.off('follow:executed', handleFollowExecuted);
    };
  }, []);

  // Keyboard handling
  useInput((input, key) => {
    // Tab switching
    if (input === '1') setActiveTab('events');
    if (input === '2') setActiveTab('leaders');
    if (input === '3') setActiveTab('positions');
    if (input === '?' || input === 'h') setActiveTab('help');

    // Watch control
    if (input === 'w') {
      if (isWatching) {
        watchEngine.stop();
        followEngine.stop();
        setIsWatching(false);
        setNotification('Watch stopped');
        refreshRuntimeStatus();
      } else {
        watchEngine.start().then(() => {
          if (config.follow.mode !== 'disabled') {
            followEngine.start();
          }
          setIsWatching(true);
          setNotification('Watch started');
          refreshRuntimeStatus();
        }).catch(err => {
          setNotification(`Error: ${err.message}`);
          refreshRuntimeStatus();
        });
      }
      setTimeout(() => setNotification(null), 2000);
    }

    // Poll once
    if (input === 'p') {
      watchEngine.poll().then(events => {
        setNotification(`Poll: ${events.length} new events`);
        setTimeout(() => setNotification(null), 2000);
        setLastUpdate(Date.now());
        refreshRuntimeStatus();
      }).catch(err => {
        setNotification(`Poll error: ${err.message}`);
        setTimeout(() => setNotification(null), 3000);
        refreshRuntimeStatus();
      });
    }

    // Quit
    if (input === 'q' || (key.ctrl && input === 'c')) {
      watchEngine.stop();
      followEngine.stop();
      exit();
    }
  });

  const activeRuntimeSnapshot = resolveActiveWatchSnapshot(runtimePid, runtimeSnapshot);
  const effectiveWatchStats = activeRuntimeSnapshot?.engine ?? watchEngine.getStats();
  const effectiveFollowStats = activeRuntimeSnapshot?.follow?.stats ?? followEngine.getStats();
  const watchStatus = buildWatchDisplayStatus({
    runningPid: runtimePid,
    stale: runtimeStale,
    snapshot: activeRuntimeSnapshot,
    engineStats: effectiveWatchStats,
    visibleErrorInfo: activeRuntimeSnapshot?.lastErrorInfo ?? effectiveWatchStats.lastError,
    visibleErrorMessage: activeRuntimeSnapshot?.lastError ?? effectiveWatchStats.lastError?.message ?? null,
  });
  const followListening = activeRuntimeSnapshot?.follow?.listening ?? followEngine.isListening();
  const followStatus = buildFollowDisplayStatus({
    mode: config.follow.mode,
    listening: followListening,
    stats: effectiveFollowStats,
  });
  const watchSourceLabel = activeRuntimeSnapshot ? 'daemon snapshot' : 'local engine';
  const watchActive = isWatching || !!runtimePid;

  const renderContent = () => {
    switch (activeTab) {
      case 'events':
        return <EventStream refreshKey={lastUpdate} />;
      case 'leaders':
        return <LeaderTable refreshKey={lastUpdate} />;
      case 'positions':
        return <PositionList refreshKey={lastUpdate} />;
      case 'help':
        return <HelpPanel />;
      default:
        return null;
    }
  };

  return (
    <Box flexDirection="column" width="100%">
      <Header
        mode={config.follow.mode}
        isWatching={watchActive}
        watchStatus={watchStatus}
        followStatus={followStatus}
        watchSourceLabel={watchSourceLabel}
        notification={notification}
      />

      <Box flexDirection="row" marginTop={1}>
        <TabButton
          label="1:Events"
          active={activeTab === 'events'}
          onClick={() => setActiveTab('events')}
        />
        <TabButton
          label="2:Leaders"
          active={activeTab === 'leaders'}
          onClick={() => setActiveTab('leaders')}
        />
        <TabButton
          label="3:Positions"
          active={activeTab === 'positions'}
          onClick={() => setActiveTab('positions')}
        />
        <TabButton
          label="?:Help"
          active={activeTab === 'help'}
          onClick={() => setActiveTab('help')}
        />
      </Box>

      <Box marginTop={1} flexGrow={1}>
        {renderContent()}
      </Box>

      <StatusBar
        mode={config.follow.mode}
        isWatching={watchActive}
        watchStats={effectiveWatchStats}
        followStats={effectiveFollowStats}
        watchStatus={watchStatus}
        followStatus={followStatus}
        watchSourceLabel={watchSourceLabel}
      />
    </Box>
  );
};

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

const TabButton: React.FC<TabButtonProps> = ({ label, active }) => {
  return (
    <Box marginRight={2}>
      <Text
        bold={active}
        color={active ? 'cyan' : 'gray'}
        inverse={active}
      >
        {` ${label} `}
      </Text>
    </Box>
  );
};
