/**
 * CopyHunter - EventStream Component
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { getEventRepo } from '../../db/index.js';
import type { EventRow } from '../../db/schema.js';
import { buildEventFollowDisplay, summarizeEventFollowDisplays } from '../../follow/index.js';

interface EventStreamProps {
  refreshKey?: number;
  limit?: number;
}

export const EventStream: React.FC<EventStreamProps> = ({ refreshKey, limit = 15 }) => {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadEvents = async () => {
      setLoading(true);
      try {
        const eventRepo = getEventRepo();
        const data = await eventRepo.find({}, limit);
        setEvents(data);
      } catch (error) {
        // Handle error silently
      }
      setLoading(false);
    };

    loadEvents();
  }, [refreshKey, limit]);

  if (loading && events.length === 0) {
    return <Text color="gray">Loading events...</Text>;
  }

  if (events.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No events captured yet.</Text>
        <Text color="gray">Press 'w' to start watching or 'p' to poll.</Text>
      </Box>
    );
  }

  const summary = summarizeEventFollowDisplays(events);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="white">
          {pad('Time', 10)}
          {pad('Type', 6)}
          {pad('Leader', 12)}
          {pad('Market', 24)}
          {pad('Amount', 10)}
          {pad('Result', 8)}
          {pad('Reason', 20)}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="gray">{'─'.repeat(90)}</Text>
      </Box>

      {events.map((event) => {
        const time = new Date(event.timestamp).toLocaleTimeString().slice(0, 8);
        const typeColor = event.eventType === 'BUY' ? 'green' : 'red';
        const market = (event.marketTitle || event.conditionId).slice(0, 22);
        const followDisplay = buildEventFollowDisplay(event);
        const followDetail = followDisplay.detail?.slice(0, 18) ?? '';

        return (
          <Box key={event.id}>
            <Text color="gray">{pad(time, 10)}</Text>
            <Text color={typeColor} bold>{pad(event.eventType, 6)}</Text>
            <Text color="cyan">{pad(`${event.leaderAddress.slice(0, 6)}...`, 12)}</Text>
            <Text>{pad(market, 24)}</Text>
            <Text color="yellow">{pad(`$${event.amountUsd.toFixed(0)}`, 10)}</Text>
            <Text color={followDisplay.color}>{pad(followDisplay.label, 8)}</Text>
            <Text color={followDisplay.color}>{pad(followDetail, 20)}</Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="gray">Showing {events.length} most recent events</Text>
      </Box>
      <Box>
        <Text color="gray">
          {`Summary: OK ${summary.byState.ok} | SKIP ${summary.byState.skip} | FAIL ${summary.byState.fail} | PEND ${summary.byState.pend}`}
        </Text>
      </Box>
      <Box>
        <Text color="gray">
          {`Categories: policy ${summary.byCategory.policy} | risk ${summary.byCategory.risk} | dependency ${summary.byCategory.dependency} | execution ${summary.byCategory.execution} | runtime ${summary.byCategory.runtime}`}
        </Text>
      </Box>
      {summary.topReasons.length > 0 && (
        <Box>
          <Text color="gray">
            {`Top: ${summary.topReasons[0].state}${summary.topReasons[0].category ? `/${summary.topReasons[0].category}` : ''} x${summary.topReasons[0].count} ${summary.topReasons[0].reason.slice(0, 48)}`}
          </Text>
        </Box>
      )}
      <Box>
        <Text color="gray">
          {`Use follow audit -n ${Math.max(limit, 50)} -o json for full breakdown`}
        </Text>
      </Box>
    </Box>
  );
};

function pad(str: string, len: number): string {
  return str.padEnd(len).slice(0, len);
}
