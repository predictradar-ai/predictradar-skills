/**
 * CopyHunter - PositionList Component
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { getPositionRepo } from '../../db/index.js';
import type { PositionRow } from '../../db/schema.js';

interface PositionListProps {
  refreshKey?: number;
}

export const PositionList: React.FC<PositionListProps> = ({ refreshKey }) => {
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [totalExposure, setTotalExposure] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadPositions = async () => {
      setLoading(true);
      try {
        const positionRepo = getPositionRepo();
        const data = await positionRepo.getOpen();
        const exposure = await positionRepo.getTotalExposure();
        setPositions(data);
        setTotalExposure(exposure);
      } catch (error) {
        // Handle error silently
      }
      setLoading(false);
    };

    loadPositions();
  }, [refreshKey]);

  if (loading && positions.length === 0) {
    return <Text color="gray">Loading positions...</Text>;
  }

  if (positions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="gray">No open positions.</Text>
        <Text color="gray">Positions will appear here when you follow trades.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="white">
          {pad('Market', 32)}
          {pad('Side', 6)}
          {pad('Qty', 10)}
          {pad('Avg $', 10)}
          {pad('Cost', 10)}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="gray">{'─'.repeat(70)}</Text>
      </Box>

      {positions.map((pos) => {
        const market = (pos.marketTitle || pos.conditionId).slice(0, 30);
        const sideColor = pos.outcome === 'YES' ? 'green' : 'red';

        return (
          <Box key={pos.id}>
            <Text>{pad(market, 32)}</Text>
            <Text color={sideColor} bold>{pad(pos.outcome, 6)}</Text>
            <Text>{pad(pos.quantity.toFixed(2), 10)}</Text>
            <Text>{pad(`$${pos.avgPrice.toFixed(4)}`, 10)}</Text>
            <Text color="yellow">{pad(`$${pos.costBasis.toFixed(2)}`, 10)}</Text>
          </Box>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        <Text color="gray">{'─'.repeat(70)}</Text>
        <Box>
          <Text>Open Positions: </Text>
          <Text color="cyan">{positions.length}</Text>
          <Text>  │  Total Exposure: </Text>
          <Text color="yellow">${totalExposure.toFixed(2)}</Text>
        </Box>
      </Box>
    </Box>
  );
};

function pad(str: string, len: number): string {
  return str.padEnd(len).slice(0, len);
}
