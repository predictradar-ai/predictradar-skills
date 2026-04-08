/**
 * CopyHunter - LeaderTable Component
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { getLeaderRepo } from '../../db/index.js';
import type { LeaderRow } from '../../db/schema.js';

interface LeaderTableProps {
  refreshKey?: number;
}

export const LeaderTable: React.FC<LeaderTableProps> = ({ refreshKey }) => {
  const [leaders, setLeaders] = useState<LeaderRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadLeaders = async () => {
      setLoading(true);
      try {
        const leaderRepo = getLeaderRepo();
        const data = await leaderRepo.getAll();
        setLeaders(data);
      } catch (error) {
        // Handle error silently
      }
      setLoading(false);
    };

    loadLeaders();
  }, [refreshKey]);

  if (loading) {
    return <Text color="gray">Loading leaders...</Text>;
  }

  if (leaders.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No leaders configured.</Text>
        <Text color="gray">Add with: copyhunter leaders add 0x...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="white">
          {pad('Alias', 15)}
          {pad('Address', 14)}
          {pad('Trades', 8)}
          {pad('Win%', 8)}
          {pad('PnL', 12)}
          {pad('Last Trade', 12)}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="gray">{'─'.repeat(70)}</Text>
      </Box>

      {leaders.map((leader, idx) => {
        const tags = leader.tags ? JSON.parse(leader.tags) : [];
        const pnlColor = leader.totalPnl >= 0 ? 'green' : 'red';
        const lastTrade = leader.lastTradeAt
          ? new Date(leader.lastTradeAt).toLocaleDateString()
          : '-';

        return (
          <Box key={leader.id}>
            <Text color="cyan">{pad(leader.alias || '-', 15)}</Text>
            <Text color="gray">{pad(`${leader.address.slice(0, 6)}...${leader.address.slice(-4)}`, 14)}</Text>
            <Text>{pad(String(leader.totalTrades), 8)}</Text>
            <Text>{pad(`${(leader.winRate * 100).toFixed(1)}%`, 8)}</Text>
            <Text color={pnlColor}>{pad(`$${leader.totalPnl.toFixed(2)}`, 12)}</Text>
            <Text color="gray">{pad(lastTrade, 12)}</Text>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text color="gray">Total: {leaders.length} leaders</Text>
      </Box>
    </Box>
  );
};

function pad(str: string, len: number): string {
  return str.padEnd(len).slice(0, len);
}
