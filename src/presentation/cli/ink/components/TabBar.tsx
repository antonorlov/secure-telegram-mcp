/**
 * TabBar — the horizontal folder-tab strip (Telegram-style): `All chats` first,
 * then one tab per folder in the account's folder order. The active tab is
 * bracketed + bold + accented; each tab shows a `selected/total` badge. A PURE
 * projection of `selectTabs(state)` — owns no state; ←/→ (handled by the screen's
 * key bindings) switch the active tab, which re-scopes the windowed list below.
 *
 * It wraps when the folders overflow the terminal width (Ink `flexWrap`), so the
 * whole strip stays visible rather than truncating a folder off the right edge.
 */
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
