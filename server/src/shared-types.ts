export const colors = ['#000000', '#000080', '#4444CC', '#44CC44', '#CC9911', '#CC4444', '#CC6600',
                       '#008040 ', '#33AAAA', '#CC44CC', '#800000', '#FF80C0', '#B87333', '#8CA9D9', '#4682B4'];

export interface Config {
  backgroundColor: string;
  fileSizeLimitInMb: number;
  navigation: { name: string; url: string; target?: string }[];
  title: string;
}

export interface Message {
  bbCode?: string;
  email?: string;
  hash: string;
  html: string;
  name: string;
  msgId: number;
  remote: boolean;
  style: string;
  time: number;
  trip: string;
}

export interface DbMessage {
  deleted: boolean;
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
  email: string;
  id: number;
  ip: string;
  last_active: number;
  last_post: number;
  name: string;
  remote: boolean;
  trip: string;
  session_id: string;
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
  theme?: string;
  tripCode: string;
}

const types = `(dat|htm|torrent|deb|lzh|ogm|doc|class|js|swift|cc|tga|ape|woff2|cab|
               whl|mpe|rmvb|srt|pdf|xz|exe|m4a|crx|vob|tif|gz|roq|m4v|gif|rb|3g2|m4a|
               rvb|sid|ai|wma|pea|bmp|py|mp4|m4p|ods|jpeg|command|azw4|otf|ebook|rtf|
               ttf|mobi|ra|flv|ogv|mpg|xls|jpg|mkv|nsv|mp3|kmz|java|lua|m2v|deb|rst|
               csv|pls|pak|egg|tlz|c|cbz|xcodeproj|iso|xm|azw|webm|3ds|azw6|azw3|cue|
               kml|woff|zipx|3gp|po|mpa|mng|wps|wpd|a|s7z|ics|tex|go|ps|org|yml|msg|
               xml|cpio|epub|docx|lha|flac|odp|wmv|vcxproj|mar|eot|less|asf|apk|css|
               mp2|odt|patch|wav|msi|rs|gsm|ogg|cbr|azw1|m|dds|h|dmg|mid|psd|dwg|aac|
               s3m|cs|cpp|au|aiff|diff|avi|bat|html|pages|bin|txt|rpm|m3u|max|vcf|svg
               |ppt|clj|png|svi|tiff|tgz|mxf|7z|drc|yuv|mov|tbz2|bz2|gpx|shar|xcf|dxf|
               jar|qt|tar|xpi|zip|thm|cxx|3dm|rar|md|scss|mpv|webp|war|pl|xlsx|mpeg|
               aaf|avchd|mod|rm|it|wasm|el|eps|nes|smc|sfc|md|smd|gen|gg|z64|v64|n64|
               gb|gbc|gba|srl|gcm|gcz|nds|dsi|wbfs|wad|cia|3ds|ngp|ngc|pce|vb|ws|wsc|
               dsv|sav|ps2|mcr|mpk|eep|st0|dta|srm|afa|zpaq|arc|paq|lpaq|swf|pdn|lol|
               php|sh|img|ico|asc|m2ts|nzb|appimage|json|dat|htm|torrent|deb|lzh|ogm|
               doc|class|js|swift|cc|tga|ape|woff2|cab|whl|mpe|rmvb|srt|pdf|xz|exe|m4a
               |crx|vob|tif|gz|roq|m4v|gif|rb|3g2|m4a|rvb|sid|ai|wma|pea|bmp|py|mp4|
               m4p|ods|jpeg|command|azw4|otf|ebook|rtf|ttf|mobi|ra|flv|ogv|mpg|xls|jpg|
               mkv|nsv|mp3|kmz|java|lua|m2v|deb|rst|csv|pls|pak|egg|tlz|c|cbz|xcodeproj
               |iso|xm|azw|webm|3ds|azw6|azw3|cue|kml|woff|zipx|3gp|po|mpa|mng|wps|wpd|
               a|s7z|ics|tex|go|ps|org|yml|msg|xml|cpio|epub|docx|lha|flac|odp|wmv|
               vcxproj|mar|eot|less|asf|apk|css|mp2|odt|patch|wav|msi|rs|gsm|ogg|cbr|
               azw1|m|dds|h|dmg|mid|psd|dwg|aac|s3m|cs|cpp|au|aiff|diff|avi|bat|html|
               pages|bin|txt|rpm|m3u|max|vcf|svg|ppt|clj|png|svi|tiff|tgz|mxf|7z|drc|
               yuv|mov|tbz2|bz2|gpx|shar|xcf|dxf|jar|qt|tar|xpi|zip|thm|cxx|3dm|rar|md|
               scss|mpv|webp|war|pl|xlsx|mpeg|aaf|avchd|mod|rm|it|wasm|el|eps|nes|smc|
               sfc|md|smd|gen|gg|z64|v64|n64|gb|gbc|gba|srl|gcm|gcz|nds|dsi|wbfs|wad|
               cia|3ds|ngp|ngc|pce|vb|ws|wsc|dsv|sav|ps2|mcr|mpk|eep|st0|dta|srm|afa|
               zpaq|arc|paq|lpaq|swf|pdn|lol|php|sh|img|ico|asc|m2ts|nzb|appimage|json)`.replace(/\s*/g, '');
export const allowedExtensions = new RegExp('\\.' + types + '$', 'i');
export const allowedTypes = new RegExp('\\b' + types + '\\b', 'i');
export const MB = 1024 * 1024;

export const sizeMap: Record<string, string> = { '0.625em': 's1', '0.8125em': 's2', '1em': 's3', '1.125em': 's4', '1.5em': 's5' };
