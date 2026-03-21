import { forEach } from '@tubular/util';

interface Theme {
  displayName: string;
  darkMode: boolean;
  name: string;
}

interface ThemeMenuStyle {
  backgroundColor: string;
  color: string;
}

const lightDefaults = {
  _background: '#DDD',
  _border: '#CCC',
  _bubble_tool_background: '#CCC',
  _color: '#000',
  _link_color: '#00E',
  _link_visited: '#528',
  _link_hover: '#06F',
  _link_active: '#F00',
  _participant_background: '#CCC',
  _toolbar_background: '#DDD',
  _toolbar_item_background: '#FFF',
  _quill_active_tool: '#0CC',
  _quill_background: '#333',
  _quill_color: '#444',
  _quill_code_background: '#EEE',
  _quill_picker_background: '#333'
};

const darkDefaults = {
  _background: '#004',
  _border: '#666',
  _bubble_tool_background: '#666',
  _color: '#DDD',
  _link_color: '#6AB0F3',
  _link_visited: '#C084FC',
  _link_hover: '#93C5FD',
  _link_active: '#FBBF24',
  _participant_background: '#666',
  _toolbar_background: '#666',
  _toolbar_item_background: '#333',
  _quill_active_tool: '#0CF',
  _quill_color: '#BBB',
  _quill_background: '#333',
  _quill_code_background: '#666',
  _quill_picker_background: '#666'
};

const themes: Record<string, any> = {
  default: {
    displayName: 'Default',
    darkMode: false,
    _background: '*'
  },
  sky: {
    displayName: 'Sky',
    darkMode: false,
    _background: '#DEF'
  },
  mint: {
    displayName: 'Mint',
    darkMode: false,
    _background: '#CFD'
  },
  desert: {
    displayName: 'Desert',
    darkMode: false,
    _background: '#FFE6C0'
  },
  abyss: {
    displayName: 'Abyss',
    darkMode: true,
    _background: '#004',
  },
  cypress: {
    displayName: 'Cypress',
    darkMode: true,
    _background: '#004040',
  },
  midnight: {
    displayName: 'Midnight',
    darkMode: true,
    _background: '#111',
  }
};

export function getThemes(): Theme[] {
  return Object.keys(themes).map(key => ({
    displayName: themes[key].displayName,
    darkMode: themes[key].darkMode,
    name: key
  }));
}

export function applyTheme(themeName: string): void {
  const root = document.documentElement;
  const theme = themes[themeName] || themes['default'];

  if (theme.darkMode)
    forEach(darkDefaults, (key, value) => !theme[key] && (theme[key] = value));
  else
    forEach(lightDefaults, (key, value) => !theme[key] && (theme[key] = value));

  forEach(theme, (key, value) => {
    if (key === '_background' && value === '*')
      value = window.getComputedStyle(root).getPropertyValue('--primary-background');

    if (key.startsWith('_')) {
      const propName = '--main' + key.replace(/_/g, '-');

      root.style.setProperty(propName, value as string);
    }
  });

  Array.from(document.body.classList).forEach(c => c.startsWith('theme-') && document.body.classList.remove(c));
  document.body.classList.add(`theme-${themeName}`);

  if (theme.darkMode)
    document.body.classList.add(`theme-dark`);
}

export function getThemeMenuStyle(themeName: string): ThemeMenuStyle {
  const theme = themes[themeName] || themes['default'];

  const result = {
    backgroundColor: theme._background,
    color: theme._color || (theme.darkMode ? darkDefaults._color : lightDefaults._color)
  };

  if (result.backgroundColor === '*')
    result.backgroundColor = window.getComputedStyle(document.documentElement).getPropertyValue('--primary-background');

  return result;
}

export function resetDefaultThemeBackground(): void {
  themes['default']._background = '*';
}
