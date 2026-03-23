import * as puppeteer from 'puppeteer';

export interface SessionInfo {
  context?: puppeteer.BrowserContext;
  ip?: string;
  inChat?: boolean;
  page?: puppeteer.Page;
  uploaderPage?: puppeteer.Page;
}
