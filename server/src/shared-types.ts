export interface Config {
  title: string;
  navigation: { name: string; url: string; target?: string }[];
}

export interface Message {
  email?: string;
  hash: string;
  name: string;
  style: string;
  text: string;
  timestamp: string;
  trip: string;
}

export interface Messages {
  errorMessage?: string;
  messages?: Message[];
  participants?: string[];
}

export interface Preferences {
  color: number;
  email: string;
  localTime: boolean;
  name: string;
  newOnBottom: boolean;
  notifySound: boolean;
  tripCode: string;
}
