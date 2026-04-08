/**
 * CopyHunter - HelpPanel Component
 */

import React from 'react';
import { Box, Text } from 'ink';

export const HelpPanel: React.FC = () => {
  return (
    <Box flexDirection="column">
      <Text bold color="yellow">Keyboard Shortcuts</Text>
      <Box marginTop={1} />

      <Section title="Navigation">
        <HelpLine keys="1" desc="Events tab - view captured trade events" />
        <HelpLine keys="2" desc="Leaders tab - view monitored leaders" />
        <HelpLine keys="3" desc="Positions tab - view open positions" />
        <HelpLine keys="? / h" desc="Help - show this panel" />
      </Section>

      <Section title="Watch Control">
        <HelpLine keys="w" desc="Toggle watch mode (start/stop monitoring)" />
        <HelpLine keys="p" desc="Poll once - fetch latest trades manually" />
      </Section>

      <Section title="General">
        <HelpLine keys="q / Ctrl+C" desc="Quit the application" />
      </Section>

      <Box marginTop={2}>
        <Text color="gray">Follow Mode: Use CLI commands to switch modes</Text>
      </Box>
      <Box>
        <Text color="gray">  copyhunter follow shadow  - Enable shadow mode</Text>
      </Box>
      <Box>
        <Text color="gray">  copyhunter follow live --confirm - Enable live trading</Text>
      </Box>
      <Box>
        <Text color="gray">  copyhunter follow stop    - Disable following</Text>
      </Box>
    </Box>
  );
};

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, children }) => (
  <Box flexDirection="column" marginTop={1}>
    <Text bold color="cyan">{title}</Text>
    <Box marginLeft={2} flexDirection="column">
      {children}
    </Box>
  </Box>
);

interface HelpLineProps {
  keys: string;
  desc: string;
}

const HelpLine: React.FC<HelpLineProps> = ({ keys, desc }) => (
  <Box>
    <Box width={12}>
      <Text color="green">{keys}</Text>
    </Box>
    <Text color="white">{desc}</Text>
  </Box>
);
