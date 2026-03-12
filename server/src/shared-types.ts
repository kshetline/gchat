export interface Message {
  name: string;
  style: string;
  text: string;
  timestamp: string;
  trip: string;
}

export interface Messages {
  messages: Message[];
  participants: string[];
  temp: any;
}

export interface Preferences {
  color: number;
  email: string;
  localTime: boolean;
  name: string;
}
