import { regexEscape } from '@tubular/util';

export const colors = ['#000000', '#000080', '#4444CC', '#44CC44', '#CC9911', '#CC4444', '#CC6600',
                       '#008040 ', '#33AAAA', '#CC44CC', '#800000', '#FF80C0', '#B87333', '#8CA9D9', '#4682B4'];

export const kaomoji = [
  '(＾_＾)', '(＾_＾；)', '(*＾＾*)', '(；_；)', '(ーー；', 'ｍ（_ _）ｍ', '(・_・)', '(＾＾）/~~',
  '(＠_＠)', '＼（＾Ｏ＾）／', '(？_？)', '(｀・ω・´) ', 'ヽ(´ー｀)ノ', '(;´Д`)', 'ヽ(´∇`)ノ', '(´∇`)σ',
  '(;^Д^)', '(;ﾟ∇ﾟ)', '(;ﾟДﾟ)', 'ヽ(`Д´)ノ', '(ρ_;)', '(´￢`)', 'ヽ(ﾟρﾟ)ノ', 'ヽ(´π｀)ノ',
  '(ﾟДﾟ)', '(´人｀)', 'ъ( ﾟｰ^)', '(⌒∇⌒ゞ)', '(^^;ﾜﾗ', '┐(´∀｀)┌', '(｀∩´)σ'
];

export const kaomojiRegex = new RegExp(`(${kaomoji.map(regexEscape).join('|')})`, 'g');
export const kaomojiEndRegex = new RegExp(`\u2000?(${kaomoji.map(regexEscape).join('|')})$`);

export interface Config {
  backgroundColor: string;
  externalUploaderName: string;
  externalUploaderShortName: string;
  fileSizeLimitInMb: number;
  fileSizeLimitExtInMb: number;
  navigation: { name: string; url: string; target?: string }[];
  title: string;
}

export interface Message {
  bbCode?: string;
  email?: string;
  hash: string;
  html: string;
  isMe?: boolean;
  name: string;
  msgId: number;
  remote: boolean;
  style: string;
  time: number;
  trip: string;
}

export interface DbMessage {
  deleted: boolean;
  dm: number;
  edit_count: number;
  email: string;
  hash: string;
  id: number;
  ip: string;
  message: string;
  name: string;
  remote: boolean;
  session_id: string;
  style: string;
  synced_time: number;
  time: number;
  trip: string;
}

export interface DbParticipant {
  allow_dm: number;
  email: string;
  id: number;
  ip: string;
  last_active: number;
  last_post: number;
  name: string;
  remote: number;
  trip: string;
  session_id: string;
}

export interface ParticipantInfo {
  allowsDms?: boolean;
  idle?: number;
  name: string;
  remote?: boolean;
}

export interface DbDmSession {
  id: number;
  key: string;
  name1: string;
  name1_present: number;
  name2: string;
  name2_present: number;
  start_time: number;
  last_post: number;
}

export interface DmSession {
  id: number;
  messages: Message[];
  name: string;
}

export interface Messages {
  dms?: DmSession[];
  errorMessage?: string;
  messages?: Message[];
  participants?: ParticipantInfo[];
}

export interface Preferences {
  allowDMs: boolean;
  color: number;
  email: string;
  localTime: boolean;
  name: string;
  newOnBottom: boolean;
  notifySound: boolean;
  suppressExternalUploadWarning: boolean;
  suppressUploadWarning: boolean;
  theme?: string;
  tripCode: string;
}

// Original list, but without .doc*, .exe, .jar (.scr and .cpl already excluded)
// noinspection SpellCheckingInspection
const types = `3dm|3ds|3g2|3gp|7z|a|aac|aaf|afa|ai|aiff|ape|apk|appimage|arc|asc|asf|au|avchd|
               avi|azw|azw1|azw3|azw4|azw6|bat|bin|bmp|bz2|c|cab|cbr|cbz|cc|cia|class|clj|command|
               cpio|cpp|crx|cs|css|csv|cue|cxx|dat|dds|deb|diff|dmg|drc|dsi|dsv|dta|dwg|
               dxf|ebook|eep|egg|el|eot|eps|epub|flac|flv|gb|gba|gbc|gcm|gcz|gen|gg|gif|go|
               gpx|gsm|gz|h|htm|html|ico|ics|img|iso|it|java|jpeg|jpg|js|json|kml|kmz|less|
               lha|lol|lpaq|lua|lzh|m|m2ts|m2v|m3u|m4a|m4p|m4v|mar|max|mcr|md|mid|mkv|mng|mobi|mod|
               mov|mp2|mp3|mp4|mpa|mpe|mpeg|mpg|mpk|mpv|msg|msi|mxf|n64|nds|nes|ngc|ngp|nsv|nzb|
               odp|ods|odt|ogg|ogm|ogv|org|otf|pages|pak|paq|patch|pce|pdf|pdn|pea|php|pl|pls|png
               |po|ppt|ps|ps2|psd|py|qt|ra|rar|rb|rm|rmvb|roq|rpm|rs|rst|rtf|rvb|s3m|s7z|sav|scss|
               sfc|sh|shar|sid|smc|smd|srl|srm|srt|st0|svg|svi|swf|swift|tar|tbz2|tex|tga|tgz|thm|
               tif|tiff|tlz|torrent|ttf|txt|v64|vb|vcf|vcxproj|vob|wad|war|wasm|wav|wbfs|webm|
               webp|whl|wma|wmv|woff|woff2|wpd|wps|ws|wsc|xcf|xcodeproj|xls|xlsx|xm|xml|xpi|xz|
               yml|yuv|z64|zip|zipx|zpaq`.replace(/\s*/g, '');
export const allowedExtensions = new RegExp('\\.(' + types + ')$', 'i');
export const allowedTypes = new RegExp('\\b(' + types + ')\\b', 'i');
export const MB = 1024 * 1024;

export const sizeMap: Record<string, string> = { '0.625em': 's1', '0.8125em': 's2', '1em': 's3', '1.125em': 's4', '1.5em': 's5' };
