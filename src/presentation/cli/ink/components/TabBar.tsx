// `All chats` first, then one tab per folder in the account's folder order, each with a
// selected/total badge. A pure projection of `selectTabs`.
import type { FC } from 'react';
import { Box, Text } from 'ink';

import { colorProps, defaultTheme, type Theme } from '../theme.js';
import type { TabBarProps } from './index.js';

export const TabBar: FC<TabBarProps & { readonly theme?: Theme }> = ({
  tabs,
  activeKey,
  theme = defaultTheme,
}) => (
  <Box flexWrap="wrap">
    {tabs.map((tab) => {
      const active = tab.key === activeKey;
      const badge =
        tab.members > 0
          ? ` ${String(tab.members)}/${String(tab.total)}`
          : ` ${String(tab.total)}`;
      const label = active ? `[ ${tab.title}${badge} ]` : `${tab.title}${badge}`;
      return (
        <Text
          key={tab.key}
          {...colorProps(active ? theme.color.title : theme.color.inherited)}
          bold={active}
        >
          {`${label}  `}
        </Text>
      );
    })}
  </Box>
);
