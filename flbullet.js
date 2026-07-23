/**
 * flbullet.js -- FUTURELAND announcement carousel
 *
 * Usage:
 *   ?flbullet.js         menu mode: show every bulletin
 *   ?flbullet.js logon   logon mode: show unread bulletins only;
 *                        exits silently when there is nothing new
 *
 * Keys: <- / -> (or P/N/space/enter) browse, up/dn scroll, PgUp/PgDn,
 *       Home/End, 1-9 jump, Q/ESC quit,
 *       A post / E edit / D delete announcement (sysop only)
 */

load("sbbsdefs.js");
require("smbdefs.js", "MSG_DELETE");
require("userdefs.js", "UFLAG_G");
load("frame.js");

var tdf = load({}, "tdfonts_lib.js");
tdf.opt = {}; // tdfonts_lib expects an `opt` object in its scope

/* ------------------------------------------------------------------ */
/* configuration                                                       */

var SUB_CODE = "LOCAL-NOTICES";
var FONT_MAP_FILE = system.data_dir + "figlet_font_map.json";
var FONT_DIR = system.ctrl_dir + "tdfonts/";
var SPRITE_META_FILE = js.exec_dir + "paperclip.sprite.json";
var MAX_BULLETINS = 50;
var BODY_MIN_ROWS = 9;    // bordered reader box, minimum height
var MAX_HEADLINE_ROWS = 12;

var MODE_LOGON = argv.length > 0 && String(argv[0]).toLowerCase() === "logon";

var BBS_NAME = (system.inet_addr || system.name || "futureland.today").toUpperCase();
var BBS_PLACE = (system.location || "Turtle Island").toUpperCase();

/* comet palette that travels clockwise around the reader box border */
var BORDER_PAL = [
	BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE, BLUE,
	BLUE, BLUE, LIGHTBLUE, LIGHTBLUE, CYAN, CYAN, LIGHTCYAN, WHITE
];

var MARQUEE_BANDS = [
	{ color: BLUE,     dir: 1,  stepMs: 150 },
	{ color: DARKGRAY, dir: -1, stepMs: 210 },
	{ color: CYAN,     dir: 1,  stepMs: 120 }
];

/* ------------------------------------------------------------------ */
/* small utilities                                                     */

function clockMs() {
	if (typeof Date !== "undefined" && Date.now) return Date.now();
	return Math.floor(time() * 1000);
}

function hashRand(seed, n) {
	if (n <= 0) return 0;
	var x = (seed ^ 0x5f3759df) >>> 0;
	x = (x * 2654435761) >>> 0;
	x ^= x >>> 13;
	x = (x * 1103515245 + 12345) >>> 0;
	return x % n;
}

function readTextFile(path) {
	var f = new File(path);
	if (!f.open("rb")) throw new Error("could not read \"" + path + "\": " + f.error);
	var content = f.read();
	f.close();
	return content;
}

function stripSauce(contents) {
	if (!contents || contents.length < 129) return contents;
	if (contents.substr(-128, 7) !== "SAUCE00") return contents;
	function fromEnd(offset) { return contents.charCodeAt(contents.length - offset); }
	var size = fromEnd(35);
	size = (size << 8) | fromEnd(36);
	size = (size << 8) | fromEnd(37);
	size = (size << 8) | fromEnd(38);
	if (size >= 0 && size <= contents.length) return contents.substr(0, size);
	return contents;
}

function dosAttrToSync(attrByte) {
	var fg = attrByte & 0x0f;
	var bg = (attrByte >> 4) & 0x07;
	var attr = fg | (bg << 4);
	if ((attrByte & 0x80) && typeof BLINK !== "undefined") attr |= BLINK;
	return attr;
}

function sanitizeChar(ch) {
	var code = ch.charCodeAt(0);
	if (code === 0 || code === 9 || code === 10 || code === 13 || code === 27) return " ";
	return ch;
}

/* ------------------------------------------------------------------ */
/* TDF font engine: tier map, measuring, cell rendering                */

var fontTiers = []; // [{height, fonts:[names]}] ascending by height
var fontCache = {};

/*	Some 90s TDF fonts ship with the artist's advertisement baked into glyph
	data (usually punctuation like @ ! ~ |). Detect glyphs whose rows contain
	readable ad vocabulary and disable them; drop fonts that are mostly ad. */
var AD_WORDS = ["font", "thedraw", "call", "made", "created", "brought", "drawn",
	"present", "release", "member", "production", "want", "more", "cool",
	"like", "just", "from", "also", "done", "this"];

function glyphHasAdText(cg) {
	for (var y = 0; y < cg.chars.length; y++) {
		var runs = cg.chars[y].match(/[A-Za-z]{4,}/g);
		if (!runs) continue;
		for (var r = 0; r < runs.length; r++) {
			var low = runs[r].toLowerCase();
			for (var w = 0; w < AD_WORDS.length; w++)
				if (low.indexOf(AD_WORDS[w]) !== -1) return true;
		}
	}
	return false;
}

/*	tdfonts_lib keeps ~half a MB of cell objects plus the raw file per font;
	loading a few dozen fonts that way exhausts the JS heap. Re-pack each
	glyph as two strings per row (chars + color bytes) and drop the raw
	data, then strip ad glyphs. */
function compactGlyph(g, height) {
	var chars = [], colors = [];
	for (var y = 0; y < height; y++) {
		var cs = "", ks = "";
		for (var x = 0; x < g.width; x++) {
			var cell = g.cell[y * g.width + x];
			cs += cell ? cell.utfchar : " ";
			ks += String.fromCharCode(cell ? cell.color : 0);
		}
		chars.push(cs);
		colors.push(ks);
	}
	return { width: g.width, chars: chars, colors: colors };
}

function slimFont(font) {
	var bad = 0, defined = 0;
	for (var i = 0; i < font.glyphs.length; i++) {
		var g = font.glyphs[i];
		if (!g) continue;
		defined++;
		var cg = compactGlyph(g, font.height);
		if (glyphHasAdText(cg)) {
			font.glyphs[i] = null;
			bad++;
		} else
			font.glyphs[i] = cg;
	}
	delete font.data;
	if (bad && bad > Math.max(3, Math.floor(defined * 0.25)))
		return null; // more ad than font
	return font;
}

function loadFontMap() {
	try {
		if (!file_exists(FONT_MAP_FILE)) return;
		var map = JSON.parse(readTextFile(FONT_MAP_FILE));
		for (var k in map) {
			var h = parseInt(k, 10);
			if (isNaN(h) || h < 2 || !Array.isArray(map[k]) || !map[k].length) continue;
			fontTiers.push({ height: h, fonts: map[k] });
		}
		fontTiers.sort(function (a, b) { return a.height - b.height; });
	} catch (e) {
		log(LOG_WARNING, "flbullet: failed loading font map: " + e);
	}
}

var fontLoadBudget = 128; // hard cap on distinct fonts parsed per session

function getFont(name) {
	if (fontCache.hasOwnProperty(name)) return fontCache[name];
	if (fontLoadBudget <= 0) return null;
	var font = null;
	try {
		if (file_exists(FONT_DIR + name + ".tdf"))
			font = tdf.loadfont(FONT_DIR + name + ".tdf");
		if (font && typeof font === "object") {
			fontLoadBudget--;
			font = slimFont(font);
		} else
			font = null;
	} catch (e) {
		font = null;
	}
	fontCache[name] = font;
	return font;
}

function fontSpaceGap(font) {
	return Math.max(2, font.spacing + 2);
}

/* Width of text in this font, or -1 if the font lacks needed glyphs */
function measureText(text, font) {
	var w = 0;
	for (var i = 0; i < text.length; i++) {
		var c = text.charAt(i);
		if (c === " ") { w += fontSpaceGap(font); continue; }
		var gi = tdf.lookupchar(c, font);
		if (gi === -1 || !font.glyphs[gi]) return -1;
		w += font.glyphs[gi].width;
		if (i < text.length - 1) w += font.spacing;
	}
	return w;
}

/*	Semi-random, deterministic per seed: try the biggest tier that fits the
	given box first, sampling fonts from the tier's pool until one both
	supports every character and fits the width. */
function pickFont(text, maxWidth, maxHeight, seed) {
	if (!text.length) return null;
	for (var t = fontTiers.length - 1; t >= 0; t--) {
		var tier = fontTiers[t];
		if (tier.height > maxHeight) continue;
		var pool = tier.fonts;
		var tries = Math.min(12, pool.length);
		for (var a = 0; a < pool.length && tries > 0; a++) {
			var name = pool[hashRand(seed + a * 7919 + tier.height * 131, pool.length)];
			var font = getFont(name);
			if (!font) continue;
			tries--;
			if (font.height > maxHeight) continue;
			var w = measureText(text, font);
			if (w > 0 && w <= maxWidth)
				return { font: font, width: w, height: font.height, name: name };
		}
	}
	/* load budget exhausted: fall back to whatever is already cached */
	if (fontLoadBudget <= 0) {
		var best = null;
		for (var cn in fontCache) {
			var cf = fontCache[cn];
			if (!cf || cf.height > maxHeight) continue;
			if (best && cf.height <= best.height) continue;
			var cw = measureText(text, cf);
			if (cw > 0 && cw <= maxWidth)
				best = { font: cf, width: cw, height: cf.height, name: cn };
		}
		if (best) return best;
	}
	return null;
}

/*	Render text to a sparse cell matrix: rows[y][x] = {ch, attr}.
	Cells the font leaves empty stay undefined (transparent). */
function renderCells(text, font) {
	var width = measureText(text, font);
	if (width < 0) return null;
	var rows = [];
	for (var y = 0; y < font.height; y++) rows.push([]);
	var x = 0;
	for (var i = 0; i < text.length; i++) {
		var c = text.charAt(i);
		if (c === " ") { x += fontSpaceGap(font); continue; }
		var gi = tdf.lookupchar(c, font);
		var g = font.glyphs[gi];
		for (var gy = 0; gy < font.height; gy++) {
			for (var gx = 0; gx < g.width; gx++) {
				var ch = g.chars[gy].charAt(gx);
				var color = g.colors[gy].charCodeAt(gx);
				if (ch !== " ")
					rows[gy][x + gx] = { ch: ch, attr: dosAttrToSync(color) };
				else if (color & 0x70)
					rows[gy][x + gx] = { ch: " ", attr: dosAttrToSync(color) };
			}
		}
		x += g.width + font.spacing;
	}
	return { width: width, height: font.height, rows: rows };
}

/*	Blit a cell matrix into a frame (0-based coords), returning the list of
	painted cells so effects like the headEffect can restore them later. */
function blitCells(frame, cells, dx, dy) {
	var painted = [];
	for (var y = 0; y < cells.height; y++) {
		var row = cells.rows[y];
		for (var x = 0; x < cells.width; x++) {
			var cell = row[x];
			if (!cell) continue;
			var px = dx + x, py = dy + y;
			if (px < 0 || py < 0 || px >= frame.width || py >= frame.height) continue;
			frame.setData(px, py, cell.ch, cell.attr);
			painted.push({ x: px, y: py, ch: cell.ch, attr: cell.attr });
		}
	}
	return painted;
}

/* ------------------------------------------------------------------ */
/* animated effects                                                    */

/* diagonal highlight band sweeping across a TDF headline */
function Shimmer(frame, cellList) {
	this.frame = frame;
	this.cells = cellList;
	this.maxD = 0;
	for (var i = 0; i < cellList.length; i++)
		if (cellList[i].x + cellList[i].y > this.maxD) this.maxD = cellList[i].x + cellList[i].y;
	this.pos = -4;
	this.stepMs = 55;
	this.restMs = 2800;
	this.nextAt = clockMs() + 1200;
}
Shimmer.prototype.tick = function (now) {
	if (now < this.nextAt) return;
	this.pos += 2;
	var done = this.pos > this.maxD + 4;
	for (var i = 0; i < this.cells.length; i++) {
		var c = this.cells[i];
		var fg = c.attr & 0x0f;
		if (fg === 0) continue;
		var attr = c.attr;
		if (!done) {
			var d = c.x + c.y - this.pos;
			if (d === 0 || d === 1) attr = (c.attr & 0xf0) | WHITE;
			else if (d === -1 || d === 2) attr = (c.attr & 0xf0) | fg | 0x08;
		}
		this.frame.setData(c.x, c.y, c.ch, attr);
	}
	if (done) {
		this.pos = -4;
		this.nextAt = now + this.restMs;
	} else
		this.nextAt = now + this.stepMs;
};

/*	Cycling rainbow wash used for plain-text headlines (when no TDF font fits
	the subject). Cells carry a phase index; the palette scrolls through it. */
var RAINBOW_PAL = [LIGHTRED, YELLOW, LIGHTGREEN, LIGHTCYAN, LIGHTBLUE, LIGHTMAGENTA];

function Rainbow(frame, cellList, stepMs) {
	this.frame = frame;
	this.cells = cellList; // {x, y, ch, phase}
	this.stepMs = stepMs || 90;
	this.tickN = 0;
	this.nextAt = 0;
}
Rainbow.prototype.tick = function (now, force) {
	if (!force && now < this.nextAt) return;
	this.nextAt = now + this.stepMs;
	this.tickN++;
	var L = RAINBOW_PAL.length;
	for (var i = 0; i < this.cells.length; i++) {
		var c = this.cells[i];
		this.frame.setData(c.x, c.y, c.ch, RAINBOW_PAL[((c.phase - this.tickN) % L + L) % L]);
	}
};

/*	Plain-text headline that stays legible on black: the subject in spaced
	caps over a solid rule, both washed with a scrolling rainbow. */
function buildRainbowHeadline(subject, yTop) {
	var title = subject.toUpperCase();
	var spaced = title.split("").join(" ");
	if (spaced.length <= cols - 8) title = spaced;      // letter-space it if there's room
	else if (title.length > cols - 4) title = title.substr(0, cols - 4);

	var f = newSlideFrame(1, yTop, cols, 3, BG_BLACK | LIGHTGRAY);
	var tx = Math.floor((f.width - title.length) / 2);
	var cells = [];
	for (var i = 0; i < title.length; i++) {
		var ch = title.charAt(i);
		if (ch === " ") continue;
		cells.push({ x: tx + i, y: 1, ch: ch, phase: i });
	}
	/* rule beneath, inset to the title's width */
	var rw = Math.min(title.length + 4, f.width);
	var rx = Math.floor((f.width - rw) / 2);
	for (var r = 0; r < rw; r++)
		cells.push({ x: rx + r, y: 2, ch: ascii(223), phase: r + 3 });

	var rb = new Rainbow(f, cells, 90);
	rb.tick(clockMs(), true);
	return { height: 3, effect: rb };
}

/* single-line box border whose palette travels clockwise */
function BorderAnim(frame, stepMs) {
	this.frame = frame;
	this.stepMs = stepMs;
	this.tickN = 0;
	this.nextAt = 0;
	this.cells = [];
	var w = frame.width, h = frame.height;
	for (var x = 0; x < w; x++)
		this.cells.push({ x: x, y: 0, ch: x === 0 ? ascii(218) : (x === w - 1 ? ascii(191) : ascii(196)) });
	for (var y = 1; y < h; y++)
		this.cells.push({ x: w - 1, y: y, ch: y === h - 1 ? ascii(217) : ascii(179) });
	for (var x2 = w - 2; x2 >= 0; x2--)
		this.cells.push({ x: x2, y: h - 1, ch: x2 === 0 ? ascii(192) : ascii(196) });
	for (var y2 = h - 2; y2 >= 1; y2--)
		this.cells.push({ x: 0, y: y2, ch: ascii(179) });
}
BorderAnim.prototype.tick = function (now, force) {
	if (!force && now < this.nextAt) return;
	this.nextAt = now + this.stepMs;
	this.tickN++;
	var L = BORDER_PAL.length;
	for (var i = 0; i < this.cells.length; i++) {
		var c = this.cells[i];
		this.frame.setData(c.x, c.y, c.ch, BORDER_PAL[((i - this.tickN) % L + L) % L]);
	}
};

/*	Horizontally scrolling band of TDF-rendered text (flattened to one dim
	color) that wraps around the screen -- the "background flourish". */
function buildStrip(text, seed) {
	var gap = 10;
	var pick = pickFont(text, 400, 6, seed);
	if (pick) {
		var cells = renderCells(text, pick.font);
		if (cells) {
			cells.width += gap;
			return cells;
		}
	}
	/* plain-text fallback strip */
	var row = [];
	for (var i = 0; i < text.length; i++)
		if (text.charAt(i) !== " ") row[i] = { ch: text.charAt(i), attr: LIGHTGRAY };
	return { width: text.length + gap, height: 1, rows: [row] };
}

function Marquee(frame, strip, y, dir, stepMs, color) {
	this.frame = frame;
	this.strip = strip;
	this.y = y;
	this.dir = dir;
	this.stepMs = stepMs;
	this.color = color;
	this.offset = hashRand(y * 31 + stepMs, strip.width);
	this.nextAt = 0;
}
Marquee.prototype.tick = function (now) {
	if (now < this.nextAt) return;
	this.nextAt = now + this.stepMs;
	this.offset = (this.offset + this.dir + this.strip.width) % this.strip.width;
	var w = this.frame.width;
	for (var ry = 0; ry < this.strip.height; ry++) {
		var py = this.y + ry;
		if (py >= this.frame.height) break;
		var row = this.strip.rows[ry];
		for (var x = 0; x < w; x++) {
			var cell = row[(x + this.offset) % this.strip.width];
			if (cell && cell.ch !== " ")
				this.frame.setData(x, py, cell.ch, this.color);
			else
				this.frame.setData(x, py, " ", LIGHTGRAY);
		}
	}
};

/* ------------------------------------------------------------------ */
/* Clippy sprite (borrowed from future_signup)                         */

function loadSpriteDefinition(path) {
	var data = JSON.parse(readTextFile(path));
	if (!data || typeof data !== "object") throw new Error("sprite metadata missing object");
	if (!Array.isArray(data.frameSize) || data.frameSize.length !== 2)
		throw new Error("sprite metadata frameSize must be [width,height]");
	if (typeof data.source !== "string" || !data.source.length)
		throw new Error("sprite metadata requires \"source\" string");
	if (!data.animations || typeof data.animations !== "object")
		throw new Error("sprite metadata missing \"animations\"");
	return data;
}

function resolveSpriteSource(def) {
	if (/^[A-Za-z]:\\/.test(def.source) || def.source.indexOf("/") === 0) return def.source;
	return def.source.indexOf("/") === -1 ? (js.exec_dir + def.source) : def.source;
}

function loadSpriteFrames(binPath, cols, rows) {
	var raw = stripSauce(readTextFile(binPath));
	var cellsPerFrame = cols * rows;
	var bytesPerFrame = null;
	var isCharAttr = false;

	function tryAdjust(len) {
		if (len % (cellsPerFrame * 2) === 0) {
			bytesPerFrame = cellsPerFrame * 2;
			isCharAttr = true;
			return true;
		}
		if (len % cellsPerFrame === 0) {
			bytesPerFrame = cellsPerFrame;
			isCharAttr = false;
			return true;
		}
		return false;
	}

	if (!tryAdjust(raw.length)) {
		if (tryAdjust(raw.length - 1))
			raw = raw.substr(0, raw.length - 1);
		else
			throw new Error(format("BIN size %lu does not align with %dx%d frames", raw.length, cols, rows));
	}

	var totalFrames = raw.length / bytesPerFrame;
	var frames = [];
	var offset = 0;
	for (var fi = 0; fi < totalFrames; fi++) {
		var frame = new Array(rows);
		for (var r = 0; r < rows; r++) {
			var row = new Array(cols);
			for (var c = 0; c < cols; c++) {
				var ch = sanitizeChar(raw.charAt(offset++));
				var attr = LIGHTGRAY;
				if (isCharAttr) attr = dosAttrToSync(raw.charCodeAt(offset++));
				row[c] = { ch: ch, attr: attr };
			}
			frame[r] = row;
		}
		frames.push(frame);
	}
	return { frames: frames, hasColor: isCharAttr };
}

/*	Draw a sprite frame, keeping black/blank cells transparent so the
	marquee background shows around Clippy. */
function drawFrameToPane(pane, frame) {
	for (var r = 0; r < frame.length; r++) {
		var row = frame[r];
		for (var c = 0; c < row.length; c++) {
			var cell = row[c];
			if (cell.ch === " " && !(cell.attr & 0x70))
				pane.clearData(c, r, false);
			else
				pane.setData(c, r, cell.ch, cell.attr);
		}
	}
}

function buildAnimations(def, totalFrames) {
	var animations = {};
	var firstKey = null;
	for (var key in def.animations) {
		if (!def.animations.hasOwnProperty(key)) continue;
		var spec = def.animations[key];
		if (!spec || !Array.isArray(spec.frames) || !spec.frames.length) continue;
		var frames = [];
		var valid = true;
		for (var i = 0; i < spec.frames.length; i++) {
			var idx = parseInt(spec.frames[i], 10);
			if (isNaN(idx) || idx < 0 || idx >= totalFrames) { valid = false; break; }
			frames.push(idx);
		}
		if (!valid) continue;
		var speed = parseInt(spec.speed, 10);
		if (isNaN(speed) || speed <= 0) speed = 200;
		if (speed < 60) speed = 60;
		animations[key] = { name: key, frames: frames, speed: speed, loop: spec.loop !== false };
		if (firstKey === null) firstKey = key;
	}
	return { map: animations, first: firstKey };
}

function SpriteAnimator(pane, frames, animations, defaultAnimation) {
	this.pane = pane;
	this.frames = frames;
	this.animations = animations;
	this.current = null;
	this.currentName = null;
	this.cursor = 0;
	this.nextTick = 0;
	this.defaultAnimation = defaultAnimation || null;
}
SpriteAnimator.prototype.play = function (name) {
	if (!this.animations.hasOwnProperty(name)) return;
	this.current = this.animations[name];
	this.currentName = name;
	this.cursor = 0;
	this.nextTick = clockMs() + this.current.speed;
	this.renderCurrentFrame();
};
SpriteAnimator.prototype.ensure = function (name) {
	if (this.currentName !== name) this.play(name);
};
SpriteAnimator.prototype.renderCurrentFrame = function () {
	if (!this.current) return;
	var frameIndex = this.current.frames[Math.min(this.cursor, this.current.frames.length - 1)];
	drawFrameToPane(this.pane, this.frames[frameIndex]);
};
SpriteAnimator.prototype.step = function (now) {
	if (!this.current) return;
	if (now < this.nextTick) return;
	if (this.current.frames.length > 1) {
		this.cursor++;
		if (this.cursor >= this.current.frames.length)
			this.cursor = this.current.loop ? 0 : this.current.frames.length - 1;
	}
	this.nextTick = now + this.current.speed;
	this.renderCurrentFrame();
};

/* ------------------------------------------------------------------ */
/* message base                                                        */

var mb = new MsgBase(SUB_CODE);
if (!mb.open()) {
	if (!MODE_LOGON) {
		console.crlf();
		console.putmsg("\1h\1rCannot open bulletin base (" + SUB_CODE + "): " + mb.last_error + "\1n\r\n");
		console.pause();
	}
	exit(0);
}

/*	Per-user, per-message read tracking in our own JSON store --
	{ "<usernum>": { "<msgnum>": <read timestamp> } } */
var READ_STORE_FILE = js.global.FLBULLET_STORE_PATH || (system.data_dir + "flbullet_read.json");

var isGuest = (user.security.restrictions & UFLAG_G) ? true : false;
var trackRead = !isGuest && user.number > 0; // guests share an account; don't persist for them

function loadReadStore() {
	try {
		if (!file_exists(READ_STORE_FILE)) return {};
		var f = new File(READ_STORE_FILE);
		if (!f.open("r")) return {};
		var data = f.read();
		f.close();
		var store = JSON.parse(data);
		return (store && typeof store === "object") ? store : {};
	} catch (e) {
		log(LOG_WARNING, "flbullet: read store load failed: " + e);
		return {};
	}
}

var readMap = trackRead ? (loadReadStore()[String(user.number)] || {}) : {};

function saveReadStore() {
	if (!trackRead) return;
	try {
		var store = loadReadStore(); // re-read to merge concurrent nodes' writes
		store[String(user.number)] = readMap;
		/* prune marks for messages that no longer exist in the base */
		for (var u in store) {
			var m = store[u];
			for (var k in m)
				if (parseInt(k, 10) < mb.first_msg) delete m[k];
		}
		var f = new File(READ_STORE_FILE);
		if (f.open("w")) {
			f.write(JSON.stringify(store));
			f.close();
		}
	} catch (e) {
		log(LOG_WARNING, "flbullet: read store save failed: " + e);
	}
}

function plainLen(s) {
	return s.replace(/\x01./g, "").length; // ignore ctrl-A color codes
}

/*	Posted bodies arrive hard-wrapped at the poster's editor width (~79), and
	the reader box is narrower, so re-wrapping them yields a full line then a
	runt line, over and over. Undo the soft wraps first: rejoin a line with
	the next when the next line's first word would have fit -- proof that the
	break was the editor's, not the author's. */
function unwrapBody(text) {
	var lines = text.split("\r\n");
	var wrapWidth = 0;
	for (var i = 0; i < lines.length; i++)
		if (plainLen(lines[i]) > wrapWidth) wrapWidth = plainLen(lines[i]);
	if (wrapWidth < 40) return text; // narrow text or ASCII art: leave it alone

	/*	A lone leading dash is usually a sentence continuation ("- I'm here to
		help"), not a bullet. Only treat markers as list items when the body
		has more than one of them. */
	var markers = 0;
	for (var m = 0; m < lines.length; m++)
		if (/^[-*+\xf9\xfa]\s/.test(lines[m])) markers++;
	var listed = markers >= 2;

	function isHardStart(line) {
		if (/^\s/.test(line)) return true;              // indented
		if (/^[>|#]/.test(line)) return true;           // quote / heading
		if (/^[-=_*]{3,}\s*$/.test(line)) return true;  // horizontal rule
		if (/^\d+[.)]\s/.test(line)) return true;       // numbered list
		if (listed && /^[-*+\xf9\xfa]\s/.test(line)) return true;
		return false;
	}

	var out = [], cur = "";
	for (var n = 0; n < lines.length; n++) {
		var line = truncsp(lines[n]);
		if (!plainLen(line)) {
			if (cur.length) { out.push(cur); cur = ""; }
			out.push("");
			continue;
		}
		if (cur.length && isHardStart(line)) { out.push(cur); cur = ""; }
		cur = cur.length ? cur + " " + line : line;

		var next = (n + 1 < lines.length) ? truncsp(lines[n + 1]) : "";
		if (!plainLen(next) || isHardStart(next)) { out.push(cur); cur = ""; continue; }
		var firstWord = next.replace(/^\s+/, "").split(/\s+/)[0];
		/* the editor would have fit this word if the author hadn't broken here */
		if (plainLen(line) + 1 + plainLen(firstWord) <= wrapWidth) { out.push(cur); cur = ""; }
	}
	if (cur.length) out.push(cur);
	return out.join("\r\n");
}

function makeBulletin(hdr) {
	var body = "";
	try { body = mb.get_msg_body(false, hdr.number) || ""; } catch (e) { body = ""; }
	body = body.replace(/\r?\n/g, "\r\n").replace(/[\r\n\s]+$/, "");
	body = unwrapBody(body);
	var subject = (hdr.subject || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
	if (!subject.length) subject = "BULLETIN";
	return {
		number: hdr.number,
		subject: subject,
		from: hdr.from || "sysop",
		when: hdr.when_written_time,
		dateStr: strftime("%A %B %d, %Y", hdr.when_written_time),
		dateBig: strftime("%b %d", hdr.when_written_time).toUpperCase(),
		body: body.length ? body : "(no message body)",
		fake: false
	};
}

/* newest first */
function loadBulletins(unreadOnly) {
	var out = [];
	for (var n = mb.last_msg; n >= mb.first_msg; n--) {
		var hdr = mb.get_msg_header(false, n);
		if (hdr === null || (hdr.attr & MSG_DELETE)) continue;
		if (unreadOnly && readMap[hdr.number]) continue;
		out.push(makeBulletin(hdr));
		if (out.length >= MAX_BULLETINS) break;
	}
	return out;
}

var bulletins = loadBulletins(MODE_LOGON);

/* logon mode: nothing new -> vanish without a single byte of output */
if (MODE_LOGON && !bulletins.length) {
	mb.close();
	exit(0);
}

function makeFakeBulletin() {
	return {
		number: 0,
		subject: "ALL QUIET",
		from: system.operator || "sysop",
		when: time(),
		dateStr: strftime("%A %B %d, %Y", time()),
		dateBig: strftime("%b %d", time()).toUpperCase(),
		body: "No bulletins have been posted yet.\r\n\r\nCheck back soon...",
		fake: true
	};
}

if (!bulletins.length)
	bulletins.push(makeFakeBulletin());

function markRead(b) {
	if (b.fake || readMap[b.number]) return;
	readMap[b.number] = time();
	saveReadStore();
}

function markAllRead() {
	var changed = false;
	for (var i = 0; i < bulletins.length; i++) {
		var b = bulletins[i];
		if (b.fake || readMap[b.number]) continue;
		readMap[b.number] = time();
		changed = true;
	}
	if (changed) saveReadStore();
	clippyReact("nod_yes", trackRead ? "All marked as read!" : "Noted! (guests aren't tracked)");
	drawStatus();
}

function isRead(b) {
	return b.fake || !!readMap[b.number];
}

/* ------------------------------------------------------------------ */
/* dumb-terminal fallback                                              */

if (!console.term_supports(USER_ANSI) || console.screen_rows < 10 || console.screen_columns < 40) {
	for (var di = 0; di < bulletins.length; di++) {
		var db = bulletins[di];
		console.crlf();
		console.putmsg("\1h\1c=== \1w" + db.subject + " \1c===\1n\r\n");
		console.putmsg("\1h\1k" + db.from + " - " + db.dateStr + "\1n\r\n\r\n");
		console.putmsg(db.body + "\1n\r\n");
		markRead(db);
		if (di < bulletins.length - 1) console.pause();
	}
	console.pause();
	mb.close();
	exit(0);
}

/* ------------------------------------------------------------------ */
/* screen construction                                                 */

loadFontMap();

var cols = console.screen_columns;
var rows = console.screen_rows;
var twoPhase = (rows < 20 || cols < 60);
var hotspotsAvailable = (typeof console.add_hotspot === "function" &&
	typeof console.clear_hotspots === "function");

var containerFrame = new Frame(1, 1, cols, rows, BG_BLACK | LIGHTGRAY);
containerFrame.open();

/* background marquee layer */
var bgFrame = new Frame(1, 1, cols, rows, BG_BLACK | LIGHTGRAY, containerFrame);
bgFrame.open();

var marquees = [];
(function () {
	var texts = [BBS_NAME, "WELCOME " + String(user.alias || user.name || "FRIEND").toUpperCase(), BBS_PLACE];
	var strips = [];
	var maxH = 0;
	for (var i = 0; i < texts.length; i++) {
		var s = buildStrip(texts[i], random(100000) + i * 977);
		strips.push(s);
		if (s.height > maxH) maxH = s.height;
	}
	var ys = [
		0,
		Math.max(0, Math.floor((rows - strips[1].height) / 2)),
		Math.max(0, rows - 2 - strips[2].height)
	];
	for (var m = 0; m < strips.length; m++) {
		var band = MARQUEE_BANDS[m % MARQUEE_BANDS.length];
		marquees.push(new Marquee(bgFrame, strips[m], ys[m], band.dir, band.stepMs, band.color));
	}
})();

/* status bar */
var statusFrame = new Frame(1, rows, cols, 1, BG_BLACK | LIGHTGRAY, containerFrame);
statusFrame.open();

/* Clippy, bottom-LEFT this time */
var clippy = null;       // {pane, animator, w, h, x, y}
var bubbleFrame = null;
var bubbleOverride = null; // {text, until}
var clippyRevertAt = 0;
var tipIndex = 0;
var tipNextAt = 0;

if (rows >= 18 && cols >= 60) {
	try {
		var spriteDef = loadSpriteDefinition(SPRITE_META_FILE);
		var spriteData = loadSpriteFrames(resolveSpriteSource(spriteDef), spriteDef.frameSize[0], spriteDef.frameSize[1]);
		var anims = buildAnimations(spriteDef, spriteData.frames.length);
		if (anims.first !== null) {
			var cw = spriteDef.frameSize[0], ch = spriteDef.frameSize[1];
			var cx = 2, cy = rows - ch;   // sits just above the status bar
			var pane = new Frame(cx, cy, cw, ch, BG_BLACK | LIGHTGRAY, containerFrame);
			pane.transparent = true;
			pane.open();
			var animator = new SpriteAnimator(pane, spriteData.frames, anims.map, "idle");
			animator.play(anims.map.idle ? "idle" : anims.first);
			clippy = { pane: pane, animator: animator, w: cw, h: ch, x: cx, y: cy };
			/* speech bubble sits to Clippy's right, over scrollable body text */
			var bx = cx + cw + 1;
			if (cols - bx >= 20) {
				bubbleFrame = new Frame(bx, cy, Math.min(44, cols - bx - 1), 3, BG_BLACK | LIGHTGRAY, containerFrame);
				bubbleFrame.transparent = true;
				bubbleFrame.open();
			}
		}
	} catch (e) {
		log(LOG_WARNING, "flbullet: clippy unavailable: " + e);
		clippy = null;
	}
}

function clippyReact(anim, bubbleText, holdMs) {
	if (clippy) {
		clippy.animator.play(anim);
		clippyRevertAt = clockMs() + (holdMs || 2000);
	}
	if (bubbleText !== undefined && bubbleText !== null)
		bubbleOverride = { text: bubbleText, until: clockMs() + (holdMs || 2000) + 1500 };
}

function drawBubble(text) {
	if (!bubbleFrame) return;
	var bw = bubbleFrame.width;
	for (var y = 0; y < 3; y++)
		for (var x = 0; x < bw; x++)
			bubbleFrame.clearData(x, y, false);
	if (!text || !text.length) return;
	var w = Math.min(text.length + 4, bw);
	var innerW = w - 4;
	var t = text.substr(0, innerW);
	var bAttr = DARKGRAY, tAttr = CYAN;
	bubbleFrame.setData(0, 0, ascii(218), bAttr);
	bubbleFrame.setData(w - 1, 0, ascii(191), bAttr);
	bubbleFrame.setData(0, 2, ascii(192), bAttr);
	bubbleFrame.setData(w - 1, 2, ascii(217), bAttr);
	for (var bx = 1; bx < w - 1; bx++) {
		bubbleFrame.setData(bx, 0, ascii(196), bAttr);
		bubbleFrame.setData(bx, 2, ascii(196), bAttr);
	}
	/* tail on the left edge, pointing back at Clippy */
	bubbleFrame.setData(0, 1, ascii(174), bAttr);
	bubbleFrame.setData(w - 1, 1, ascii(179), bAttr);
	bubbleFrame.setData(1, 1, " ", tAttr);
	for (var tx = 0; tx < innerW; tx++)
		bubbleFrame.setData(2 + tx, 1, tx < t.length ? t.charAt(tx) : " ", tAttr);
}

/* ------------------------------------------------------------------ */
/* slide rendering                                                     */

var slideFrames = [];
var headEffect = null;
var borderAnim = null;
var bodyInner = null;
var bodyScrollMax = 0;
var cur = 0;
var curPhase = "full";
var done = false;
var statusHotspots = []; // {cmd, minx, maxx} on the status row

function newSlideFrame(x, y, w, h, attr) {
	var f = new Frame(x, y, w, h, attr, containerFrame);
	f.open();
	slideFrames.push(f);
	return f;
}

function closeSlideFrames() {
	while (slideFrames.length) {
		var f = slideFrames.pop();
		try { f.close(); f.delete(); } catch (e) { }
	}
	headEffect = null;
	borderAnim = null;
	bodyInner = null;
	bodyScrollMax = 0;
}

function buildHeadline(b, yTop, maxH) {
	var pick = pickFont(b.subject, cols - 2, Math.min(maxH, MAX_HEADLINE_ROWS), b.number * 97 + 13);
	if (pick) {
		var cells = renderCells(b.subject, pick.font);
		if (cells) {
			var hx = Math.max(1, Math.floor((cols - cells.width) / 2) + 1);
			var hf = newSlideFrame(hx, yTop, Math.min(cells.width, cols), cells.height, BG_BLACK | LIGHTGRAY);
			var painted = blitCells(hf, cells, 0, 0);
			headEffect = new Shimmer(hf, painted);
			return { height: cells.height };
		}
	}
	/* no font fits: rainbow-washed plain text so it still pops off the black */
	var rb = buildRainbowHeadline(b.subject, yTop);
	headEffect = rb.effect;
	return { height: rb.height };
}

function buildDateLine(b, yTop, maxH) {
	if (maxH >= 4) {
		var pick = pickFont(b.dateBig, cols - 2, Math.min(6, maxH), b.number * 53 + 7);
		if (pick) {
			var cells = renderCells(b.dateBig, pick.font);
			if (cells) {
				var dx = Math.max(1, Math.floor((cols - cells.width) / 2) + 1);
				var df = newSlideFrame(dx, yTop, Math.min(cells.width, cols), cells.height, BG_BLACK | LIGHTGRAY);
				blitCells(df, cells, 0, 0);
				return cells.height;
			}
		}
	}
	/* plain date line: bright enough to read against the black backdrop */
	var lf = newSlideFrame(1, yTop, cols, 1, BG_BLACK | LIGHTGRAY);
	lf.gotoxy(1, 1);
	lf.center("\1h\1m" + ascii(196) + ascii(196) + ascii(196) + " \1h\1w" + b.dateStr + " \1h\1m" + ascii(196) + ascii(196) + ascii(196) + "\1n");
	return 1;
}

function buildBodyBox(b, top, bottom) {
	var h = bottom - top + 1;
	if (h < 5) { h = 5; top = Math.max(1, bottom - 4); }
	var w = Math.min(cols - 4, 78);
	var x = Math.max(1, Math.floor((cols - w) / 2) + 1);
	var box = newSlideFrame(x, top, w, h, BG_BLACK | LIGHTGRAY);
	borderAnim = new BorderAnim(box, 110);
	borderAnim.tick(clockMs(), true);

	bodyInner = newSlideFrame(x + 2, top + 1, w - 4, h - 2, BG_BLACK | LIGHTGRAY);
	bodyInner.word_wrap = true;
	bodyInner.v_scroll = true;
	bodyInner.putmsg("\1h\1w" + b.subject + "\1n\r\n" +
		"\1n\1w" + b.from + " " + ascii(250) + " " + b.dateStr + "\1n\r\n\r\n" +
		"\1h\1y" + b.body + "\1n");
	bodyScrollMax = Math.max(0, bodyInner.data_height - bodyInner.height);
	bodyInner.scrollTo(0, 0);
}

function buildTitleCard(b) {
	var maxHead = Math.max(4, rows - 8);
	var pick = pickFont(b.subject, cols - 2, Math.min(maxHead, MAX_HEADLINE_ROWS), b.number * 97 + 13);
	var headH = pick ? pick.height : 3;
	var dateH = 1;
	var total = headH + 1 + dateH;
	var y0 = Math.max(2, Math.floor((rows - total) / 2));
	var head = buildHeadlineAt(b, y0, pick);
	buildDateLine(b, y0 + head.height + 1, 0);
	var hintF = newSlideFrame(1, rows - 1, cols, 1, BG_BLACK | LIGHTGRAY);
	hintF.gotoxy(1, 1);
	hintF.center("\1h\1k" + ascii(175) + " \1n\1cpress a key to read \1h\1k" + ascii(174) + "\1n");
	return;

	function buildHeadlineAt(b2, yTop, pick2) {
		if (pick2) {
			var cells = renderCells(b2.subject, pick2.font);
			if (cells) {
				var hx = Math.max(1, Math.floor((cols - cells.width) / 2) + 1);
				var hf = newSlideFrame(hx, yTop, Math.min(cells.width, cols), cells.height, BG_BLACK | LIGHTGRAY);
				var painted = blitCells(hf, cells, 0, 0);
				headEffect = new Shimmer(hf, painted);
				return { height: cells.height };
			}
		}
		var rb = buildRainbowHeadline(b2.subject, yTop);
		headEffect = rb.effect;
		return { height: rb.height };
	}
}

function drawStatus() {
	statusFrame.clear();
	statusHotspots = [];
	var x = 2; // 1-based column within the status row

	function seg(text, plainLen, cmd) {
		statusFrame.gotoxy(x, 1);
		statusFrame.putmsg(text);
		if (cmd && hotspotsAvailable)
			statusHotspots.push({ cmd: cmd, minx: x, maxx: x + plainLen - 1 });
		x += plainLen + 3;
	}

	if (curPhase === "title") {
		seg("\1h\1cENTER\1n\1h\1k read\1n", 10, "\r");
	} else {
		if (bulletins.length > 1) {
			seg("\1n\1c" + ascii(174) + "\1h\1cP\1n\1h\1krev\1n", 5, "p");
			seg("\1h\1cN\1n\1h\1kext\1c\1h" + ascii(175) + "\1n", 5, "n");
		}
		if (bodyScrollMax > 0) {
			var pct = bodyInner ? Math.floor((Math.min(bodyInner.offset.y, bodyScrollMax) / bodyScrollMax) * 100) : 0;
			seg("\1h\1cup/dn\1n\1h\1k scroll " + pct + "%\1n", 16, null);
		}
	}
	if (trackRead)
		seg("\1h\1cM\1n\1h\1kark all as read\1n", 16, "m");
	seg("\1h\1cQ\1n\1h\1kuit\1n", 4, "q");
	if (user.is_sysop) {
		seg("\1h\1cA\1n\1h\1kdd\1n", 3, "a");
		if (!bulletins[cur].fake) {
			seg("\1h\1cE\1n\1h\1kdit\1n", 4, "e");
			seg("\1h\1cD\1n\1h\1kel\1n", 3, "d");
		}
	}

	/* right side: position dots + counter */
	var n = bulletins.length;
	var counter = (cur + 1) + "/" + n;
	var showDots = n > 1 && n <= 10;
	var plainRight = counter.length + (showDots ? n * 2 + 1 : 0);
	var rx = cols - plainRight - 1;
	if (rx > x) {
		statusFrame.gotoxy(rx, 1);
		if (showDots) {
			var dots = "";
			for (var i = 0; i < n; i++) {
				if (i === cur) dots += "\1h\1w" + ascii(254) + "\1n ";
				else if (isRead(bulletins[i])) dots += "\1h\1k" + ascii(250) + "\1n ";
				else dots += "\1h\1c" + ascii(250) + "\1n ";
			}
			statusFrame.putmsg(dots);
		}
		statusFrame.putmsg("\1h\1k" + counter + "\1n");
	}
}

function registerHotspots() {
	if (!hotspotsAvailable) return;
	console.clear_hotspots();
	for (var i = 0; i < statusHotspots.length; i++) {
		var hs = statusHotspots[i];
		console.add_hotspot(hs.cmd, true, hs.minx, hs.maxx, rows - 1);
	}
	if (clippy) {
		for (var cy = clippy.y - 1; cy < clippy.y - 1 + clippy.h; cy++)
			console.add_hotspot("c", true, clippy.x, clippy.x + clippy.w - 1, cy);
	}
}

var TIPS = (function () {
	var t = [];
	if (bulletins.length > 1) t.push(ascii(174) + " " + ascii(175) + " to flip through the news!");
	t.push("Up/down scrolls long bulletins.");
	if (trackRead) t.push("M marks everything as read.");
	t.push("Q gets you out of here.");
	if (user.is_sysop) t.push("Psst... A posts, E edits, D deletes.");
	t.push("Click me if you're bored.");
	return t;
})();

function updateBubble(now) {
	if (!bubbleFrame) return;
	if (bubbleOverride) {
		if (now < bubbleOverride.until) { drawBubble(bubbleOverride.text); return; }
		bubbleOverride = null;
		tipNextAt = 0;
	}
	if (now >= tipNextAt) {
		tipNextAt = now + 9000;
		var text;
		if (bulletins[cur] && bulletins[cur].fake)
			text = "No news is good news!";
		else if (MODE_LOGON && cur === bulletins.length - 1)
			text = "You're all caught up! " + ascii(175) + " exits.";
		else
			text = TIPS[tipIndex++ % TIPS.length];
		drawBubble(text);
	}
}

function renderSlide(idx, phase) {
	cur = idx;
	curPhase = phase || (twoPhase ? "title" : "full");
	closeSlideFrames();
	var b = bulletins[idx];

	if (curPhase === "title") {
		buildTitleCard(b);
	} else if (curPhase === "body") {
		buildBodyBox(b, 2, rows - 1);
	} else {
		var head = buildHeadline(b, 2, Math.max(4, rows - 13));
		var dateY = 2 + head.height;
		var dateMaxH = rows - 12 - head.height;
		var dateH = buildDateLine(b, dateY + 1, dateMaxH);
		buildBodyBox(b, dateY + 1 + dateH + 1, rows - 1);
		log(LOG_DEBUG, format("flbullet: slide %d headH=%d dateY=%d dateH=%d boxTop=%d",
			idx, head.height, dateY + 1, dateH, dateY + 1 + dateH + 1));
	}

	if (clippy) clippy.pane.top();
	if (bubbleFrame) bubbleFrame.top();
	drawStatus();
	registerHotspots();
	tipNextAt = 0; // refresh bubble text for the new slide
	markRead(b);
}

/* ------------------------------------------------------------------ */
/* navigation & input                                                  */

function scrollBody(dy) {
	if (!bodyInner || bodyScrollMax <= 0) return;
	var off = bodyInner.offset.y;
	var target = Math.max(0, Math.min(bodyScrollMax, off + dy));
	if (target === off) return;
	bodyInner.scrollTo(0, target);
	drawStatus();
}

function advance() {
	if (curPhase === "title") { renderSlide(cur, "body"); clippyReact("point_right"); return; }
	if (cur + 1 < bulletins.length) {
		renderSlide(cur + 1);
		if (cur === bulletins.length - 1) clippyReact("celebrate", "You've seen them all!");
		else clippyReact("point_right");
	} else if (MODE_LOGON) {
		done = true;
	} else if (bulletins.length > 1) {
		clippyReact("nod_yes", "Back to the start!");
		renderSlide(0);
	}
}

function retreat() {
	if (curPhase === "body" && twoPhase) { renderSlide(cur, "title"); return; }
	if (cur > 0) renderSlide(cur - 1);
	else if (!MODE_LOGON && bulletins.length > 1) renderSlide(bulletins.length - 1);
	else clippyReact("shake_no");
}

/* centered bordered modal frame; caller finishes with closeModal() */
function openModal(title, maxW, maxH) {
	var w = Math.min(cols - 6, maxW);
	var h = Math.min(maxH, rows - 2);
	var mx = Math.floor((cols - w) / 2) + 1;
	var my = Math.floor((rows - h) / 2) + 1;
	var modal = new Frame(mx, my, w, h, BG_BLACK | LIGHTGRAY, containerFrame);
	modal.open();
	var mBorder = new BorderAnim(modal, 0);
	/* static border for the modal */
	for (var i = 0; i < mBorder.cells.length; i++)
		modal.setData(mBorder.cells[i].x, mBorder.cells[i].y, mBorder.cells[i].ch, LIGHTCYAN);
	modal.gotoxy(1, 1);
	modal.center("\1h\1c[ " + title + " ]\1n");
	return { frame: modal, x: mx, y: my, w: w, h: h };
}

function closeModal(m) {
	m.frame.close();
	try { m.frame.delete(); } catch (e) { }
	containerFrame.invalidate();
}

function announceModal() {
	if (!user.is_sysop) return;
	var m = openModal("POST ANNOUNCEMENT", 72, 14);
	var modal = m.frame, mx = m.x, my = m.y, w = m.w, h = m.h;
	modal.gotoxy(3, 3);
	modal.putmsg("\1h\1wTitle:\1n");
	modal.gotoxy(3, 5);
	modal.putmsg("\1h\1wBody \1n\1h\1k(blank line ends)\1n");
	containerFrame.cycle();

	var posted = false;
	console.gotoxy(mx + 10, my + 2);
	console.attributes = WHITE;
	var subj = console.getstr("", Math.min(60, w - 13), K_LINE);
	if (subj !== null && subj.replace(/\s+/g, "").length) {
		var lines = [];
		var maxLines = h - 8;
		for (var li = 0; li < maxLines; li++) {
			console.gotoxy(mx + 2, my + 5 + li);
			console.attributes = LIGHTGRAY;
			var ln = console.getstr("", w - 5, K_LINE);
			if (ln === null || (!ln.length && lines.length)) break;
			if (!ln.length && !lines.length) break;
			lines.push(ln);
		}
		if (lines.length) {
			console.gotoxy(mx + 2, my + h - 2);
			console.putmsg("\1h\1yPost this announcement? (Y/N) \1n");
			if (console.getkeys("YN") === "Y") {
				var hdr = { to: "All", from: user.alias || user.name, subject: subj };
				if (mb.save_msg(hdr, lines.join("\r\n"))) {
					posted = true;
					log(LOG_INFO, "flbullet: announcement posted: " + subj);
				} else {
					log(LOG_ERR, "flbullet: save_msg failed: " + mb.last_error);
				}
			}
		}
	}

	closeModal(m);

	if (posted) {
		var newHdr = mb.get_msg_header(false, mb.last_msg);
		if (newHdr) {
			if (bulletins.length === 1 && bulletins[0].fake) bulletins.length = 0;
			bulletins.unshift(makeBulletin(newHdr)); // newest first
			renderSlide(0, twoPhase ? "title" : "full");
			clippyReact("celebrate", "Announcement is live!");
			return;
		}
	}
	renderSlide(cur, curPhase);
}

/* re-read one bulletin from the base after an edit */
function refreshBulletin(idx) {
	var hdr = mb.get_msg_header(false, bulletins[idx].number);
	if (hdr && !(hdr.attr & MSG_DELETE))
		bulletins[idx] = makeBulletin(hdr);
}

function editModal() {
	if (!user.is_sysop) return;
	var b = bulletins[cur];
	if (b.fake) { clippyReact("shake_no", "Nothing here to edit!"); return; }

	var m = openModal("EDIT ANNOUNCEMENT", 72, 9);
	m.frame.gotoxy(3, 3);
	m.frame.putmsg("\1n\1w" + b.subject.substr(0, m.w - 6) + "\1n");
	m.frame.gotoxy(3, 5);
	m.frame.putmsg("\1h\1wEdit the \1cT\1witle, the \1cB\1wody, or \1cQ\1wuit? \1n");
	containerFrame.cycle();
	console.gotoxy(m.x + 38, m.y + 4);
	console.attributes = WHITE;
	var choice = console.getkeys("TBQ");
	var changed = false, err = null;

	if (choice === "T") {
		/* prompt row becomes a prefilled title editor */
		for (var cx = 1; cx < m.w - 1; cx++) m.frame.setData(cx, 4, " ", LIGHTGRAY);
		m.frame.gotoxy(3, 5);
		m.frame.putmsg("\1h\1wTitle:\1n");
		containerFrame.cycle();
		console.gotoxy(m.x + 9, m.y + 4);
		console.attributes = WHITE;
		var subj = console.getstr(b.subject, Math.min(60, m.w - 12), K_EDIT | K_LINE);
		if (subj !== null) subj = subj.replace(/^\s+|\s+$/g, "");
		if (subj && subj.length && subj !== b.subject) {
			/* header must be fetched unexpanded to be re-written */
			var hdr = mb.get_msg_header(false, b.number, /* expand_fields: */ false);
			if (hdr) {
				hdr.subject = subj;
				if (mb.put_msg_header(false, b.number, hdr)) {
					changed = true;
					log(LOG_INFO, "flbullet: title edited on msg #" + b.number + ": " + subj);
				} else {
					err = "Couldn't save the new title!";
					log(LOG_ERR, "flbullet: put_msg_header failed: " + mb.last_error);
				}
			} else
				err = "Couldn't re-read the message!";
		}
	} else if (choice === "B") {
		if (typeof bbs.edit_msg !== "function")
			err = "This build lacks bbs.edit_msg!";
		else {
			/*	bbs.edit_msg() re-writes the body in place (same message
				number), so read tracking and carousel order are unaffected.
				The external editor owns the whole screen while it runs. */
			var hdrFull = mb.get_msg_header(false, b.number);
			closeModal(m);
			m = null;
			console.clear();
			console.attributes = LIGHTGRAY;
			if (hdrFull && bbs.edit_msg(hdrFull)) {
				changed = true;
				log(LOG_INFO, "flbullet: body edited on msg #" + b.number);
			}
			containerFrame.invalidate();
		}
	}

	if (m) closeModal(m);
	if (changed) refreshBulletin(cur);
	renderSlide(cur, curPhase);
	if (changed) clippyReact("celebrate", "Announcement updated!");
	else if (err) clippyReact("shake_no", err);
}

function deleteModal() {
	if (!user.is_sysop) return;
	var b = bulletins[cur];
	if (b.fake) { clippyReact("shake_no", "Nothing here to delete!"); return; }

	var m = openModal("DELETE ANNOUNCEMENT", 72, 8);
	m.frame.gotoxy(3, 3);
	m.frame.putmsg("\1n\1w" + b.subject.substr(0, m.w - 6) + "\1n");
	m.frame.gotoxy(3, 4);
	m.frame.putmsg("\1h\1k" + b.from + " " + ascii(250) + " " + b.dateStr + "\1n");
	m.frame.gotoxy(3, 6);
	m.frame.putmsg("\1h\1yDelete this announcement? (Y/N) \1n");
	containerFrame.cycle();
	console.gotoxy(m.x + 35, m.y + 5);
	console.attributes = WHITE;
	var yn = console.getkeys("YN");
	closeModal(m);

	if (yn === "Y") {
		/*	soft delete: sets MSG_DELETE on the header; the message stays in
			the base (and is skipped here) until normal purge maintenance */
		if (mb.remove_msg(false, b.number)) {
			log(LOG_INFO, "flbullet: announcement deleted: #" + b.number + " " + b.subject);
			bulletins.splice(cur, 1);
			if (!bulletins.length) {
				if (MODE_LOGON) { done = true; return; }
				bulletins.push(makeFakeBulletin());
			}
			if (cur >= bulletins.length) cur = bulletins.length - 1;
			renderSlide(cur, twoPhase ? "title" : "full");
			clippyReact("nod_yes", "Poof! It's gone.");
			return;
		}
		log(LOG_ERR, "flbullet: remove_msg failed: " + mb.last_error);
		renderSlide(cur, curPhase);
		clippyReact("shake_no", "Delete failed (see log)!");
		return;
	}
	renderSlide(cur, curPhase);
}

function handleKey(key) {
	switch (key) {
		case "q": case "Q": case "\x1b": case "\x03":
			done = true;
			break;
		/* NOTE: no "\n" here -- KEY_DOWN is also \x0a and must scroll */
		case KEY_RIGHT: case " ": case "\r": case "n": case "N":
			advance();
			break;
		case KEY_LEFT: case "p": case "P": case "b": case "B":
			retreat();
			break;
		case KEY_UP: case "k": case "K":
			if (curPhase === "title") retreat();
			else scrollBody(-1);
			break;
		case KEY_DOWN: case "j": case "J":
			if (curPhase === "title") advance();
			else scrollBody(1);
			break;
		case KEY_PAGEUP:
			scrollBody(-(bodyInner ? bodyInner.height - 1 : 5));
			break;
		case KEY_PAGEDN:
			scrollBody(bodyInner ? bodyInner.height - 1 : 5);
			break;
		case KEY_HOME:
			scrollBody(-99999);
			break;
		case KEY_END:
			scrollBody(99999);
			break;
		case "a": case "A":
			announceModal();
			break;
		case "e": case "E":
			editModal();
			break;
		case "d": case "D":
			deleteModal();
			break;
		case "m": case "M":
			markAllRead();
			break;
		case "c": case "C":
			clippyReact("celebrate", "Wheee!");
			break;
		case "t": case "T":
			if (twoPhase) renderSlide(cur, "title");
			break;
		default:
			if (key >= "1" && key <= "9") {
				var target = key.charCodeAt(0) - 49;
				if (target < bulletins.length && target !== cur) {
					renderSlide(target);
					clippyReact("point_right");
				}
			}
			break;
	}
}

/* ------------------------------------------------------------------ */
/* main loop                                                           */

try {
	/* logon mode starts at the first (oldest) unread; menu mode too */
	renderSlide(0);
	containerFrame.draw();

	while (!done && bbs.online) {
		var key = console.inkey(K_NONE, 40);
		if (console.aborted) { console.aborted = false; break; }
		if (key) handleKey(key);
		if (done) break;

		var now = clockMs();
		for (var mi = 0; mi < marquees.length; mi++) marquees[mi].tick(now);
		if (borderAnim) borderAnim.tick(now);
		if (headEffect) headEffect.tick(now);
		if (clippy) {
			if (clippyRevertAt && now >= clippyRevertAt) {
				clippyRevertAt = 0;
				clippy.animator.ensure("idle");
			}
			clippy.animator.step(now);
		}
		updateBubble(now);
		containerFrame.cycle();
	}
} finally {
	if (hotspotsAvailable) console.clear_hotspots();
	try { containerFrame.close(); } catch (e) { }
	mb.close();
	console.attributes = LIGHTGRAY;
	console.clear();
}
