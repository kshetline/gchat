import * as puppeteer from 'puppeteer';

export interface SessionInfo {
  context?: puppeteer.BrowserContext;
  inChat?: boolean;
  page?: puppeteer.Page;
  uploaderPage?: puppeteer.Page;
}
