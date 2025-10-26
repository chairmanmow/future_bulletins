load("sbbsdefs.js");
load("frame.js");
load("tree.js");

var bannerLocation = js.exec_dir + "fl_announce_banner.bin"
var noticeLocation = "../text/notices.txt";
if (!js.global.frame instanceof Frame)
	js.global.frame = new Frame();

var xScreenColumns = console.screen_columns;
var yScreenRows = console.screen_rows;
var hotspotsAvailable = (typeof console.add_hotspot === "function" && typeof console.clear_hotspots === "function");
var treeHotspotBaseChar = 33; // '!'
var treeHotspotCount = 0;
var modalHotspotKey = "~";

/*	Word-wrap and centre a string that may span multiple lines, and may already
	be multi-line itself. */
Frame.prototype.centerWrap = function (str) {
	var self = this;
	var arr = [''];
	str.split('\r\n').forEach(
		function (line, i, a) {
			line.split(' ').forEach(
				function (word) {
					if ((arr[arr.length - 1] + ' ' + word).length <=
						self.width
					) {
						arr[arr.length - 1] += (' ' + word);
					} else if (word.length > self.width) {
						arr.push(word.substr(0, self.width - 1) + '-');
						arr.push(word.substr(self.width - 1));
					} else {
						arr.push(word);
					}
				}
			);
			if (i < a.length - 1) arr.push('');
		}
	);
	arr.forEach(
		function (word, i, a) {
			self.center(skipsp(truncsp(word)));
			if (i < a.length - 1) self.crlf();
		}
	);
}

// Center this frame within other frame 'p', or the terminal if 'p' is omitted
Frame.prototype.centralize = function (p) {
	if (typeof p === 'undefined') {
		var p = {
			x: 1,
			y: 1,
			width: console.screen_columns,
			height: console.screen_rows
		};
	}
	var xy = {
		x: p.x + Math.floor((p.width - this.width) / 2),
		y: p.y + Math.floor((p.height - this.height) / 2)
	};
	this.moveTo(xy.x, xy.y);
}

Frame.prototype.drawBorder = function (color, title) {
	this.pushxy();
	var theColor = color;
	if (Array.isArray(color)) {
		var sectionLength = Math.round(this.width / color.length);
	}
	for (var y = 1; y <= this.height; y++) {
		for (var x = 1; x <= this.width; x++) {
			if (x > 1 && x < this.width && y > 1 && y < this.height) continue;
			var msg;
			this.gotoxy(x, y);
			if (y == 1 && x == 1) {
				msg = ascii(218);
			} else if (y == 1 && x == this.width) {
				msg = ascii(191);
			} else if (y == this.height && x == 1) {
				msg = ascii(192);
			} else if (y == this.height && x == this.width) {
				msg = ascii(217);
			} else if (x == 1 || x == this.width) {
				msg = ascii(179);
			} else {
				msg = ascii(196);
			}
			if (typeof sectionLength != 'undefined') {
				if (x == 1) {
					theColor = color[0];
				} else if (x % sectionLength == 0 && x < this.width) {
					theColor = color[x / sectionLength];
				} else if (x == this.width) {
					theColor = color[color.length - 1];
				}
			}
			this.putmsg(msg, theColor);
		}
	}
	if (typeof title == 'object') {
		this.gotoxy(title.x, title.y);
		this.attr = title.attr;
		this.putmsg(ascii(180) + title.text + ascii(195));
	}
	this.popxy();
}

function registerTreeHotspots() {
	if (!hotspotsAvailable || !msgTree || !msgTree.frame)
		return;
	console.clear_hotspots();
	var frame = msgTree.frame;
	var visible = msgTree.height - msgTree.offset;
	if (visible > frame.height)
		visible = frame.height;
	if (visible < 0)
		visible = 0;
	treeHotspotCount = visible;
	for (var row = 0; row < visible; row++) {
		var key = String.fromCharCode(treeHotspotBaseChar + row);
		console.add_hotspot(key, true, frame.x, frame.x + frame.width - 1, frame.y + row - 1);
	}
}

function clearHotspots() {
	if (!hotspotsAvailable)
		return;
	console.clear_hotspots();
	treeHotspotCount = 0;
}

function registerModalHotspots(frame) {
	if (!hotspotsAvailable)
		return;
	console.clear_hotspots();
	for (var row = 0; row < frame.height; row++) {
		console.add_hotspot(modalHotspotKey, true, frame.x, frame.x + frame.width - 1, frame.y + row - 1);
	}
}

function hotspotRowFromKey(key) {
	if (!hotspotsAvailable || !key || key.length === 0 || treeHotspotCount <= 0)
		return -1;
	var code = key.charCodeAt(0) - treeHotspotBaseChar;
	if (code >= 0 && code < treeHotspotCount)
		return code;
	return -1;
}

function selectTreeRowByOffset(rowOffset) {
	if (rowOffset < 0 || !msgTree || !msgTree.__properties__)
		return;
	var target = msgTree.offset + rowOffset;
	var guard = msgTree.__properties__.items.length + 10;
	while (msgTree.__properties__.index < target && guard-- > 0) {
		if (msgTree.down() !== msgTree.__values__.HANDLED)
			break;
	}
	guard = msgTree.__properties__.items.length + 10;
	while (msgTree.__properties__.index > target && guard-- > 0) {
		if (msgTree.up() !== msgTree.__values__.HANDLED)
			break;
	}
	msgTree.getcmd(msgTree.__commands__.SELECT);
}

function noise(frame, bits, chars, colors) {
	var t = "";
	for (var x = 0; x < bits; x++) {
		var randx = random(frame.width);
		var randy = random(frame.height);
		var r = random(chars.length);
		t = chars[r];
		frame.setData(randx, randy, t, colors[random(colors.length)]);
	}
}
var containerFrame = new Frame(1, 1, xScreenColumns, yScreenRows, BG_BLACK | LIGHTGRAY);
containerFrame.open();
var centerXFramePos = parseInt((containerFrame.width - 78) / 2)
var headerHeight = 6;
var messageMargin = 1;
var noticeHeight = 0;
var headerFrame = new Frame(
	x = centerXFramePos, // containerFrame.width - 80 + 1
	y = containerFrame.y,
	width = xScreenColumns > 80 ? 80 : xScreenColumns,
	height = headerHeight,
	attr = BG_BLACK | BLACK,
	parent = containerFrame
);
var msgBoardTop = headerFrame.y + headerFrame.height + messageMargin;
var availableMessageRows = yScreenRows - noticeHeight - msgBoardTop;
var msgBoardHeight = availableMessageRows >= 1 ? availableMessageRows : 1;
var margin = parseInt((console.screen_columns - 80) / 2);
var msgBoardFrame = new Frame(margin, msgBoardTop, 80, msgBoardHeight, BG_GREEN | LIGHTGREEN, containerFrame);
var maxNoiseY = yScreenRows - noticeHeight + 1;

mbcode = "LOCAL-NOTICES";
var mb = new MsgBase(mbcode);

var msgTree = new Tree(msgBoardFrame, "bulletin test");
var treeRefresh = msgTree.refresh;
msgTree.refresh = function () {
	var result = treeRefresh.apply(this, arguments);
	if (this === msgTree)
		registerTreeHotspots();
	return result;
};

msgTree.colors = {
	fg: WHITE,
	// non-current item/empty space background 
	bg: BG_BLACK,
	// current item foreground
	lfg: BLACK,
	// current item background
	lbg: BG_CYAN,
	// current tree heading foreground
	cfg: WHITE,
	// current tree heading background
	cbg: BG_CYAN,
	// disabled item foreground
	dfg: DARKGRAY,
	// hotkey foreground
	kfg: LIGHTMAGENTA,
	// tree branch foreground
	tfg: BLACK,
	// tree heading foreground
	hfg: WHITE,
	// tree heading background
	hbg: BG_BLUE,
	// tree expansion foreground
	xfg: RED
}
var body = new String;

function readMessage(msgNum) {
	body = mb.get_msg_body(msgNum);
	var popUpFrame = new Frame(
		x = Math.floor(console.screen_columns / 4),
		y = Math.floor(console.screen_rows / 6) + 4,
		width = Math.max(10, Math.floor(console.screen_columns / 2)),
		height = Math.max(6, Math.floor(console.screen_rows / 2)) + 3,
		attr = BG_BLACK | WHITE,
		parent = containerFrame
	);
	var innerWidth = popUpFrame.width - 2;
	var innerHeight = popUpFrame.height - 4;
	var rows = parseInt(body.length / innerWidth) + 4;
	var innerFrame = new Frame(
		x = popUpFrame.x + 1,
		y = popUpFrame.y + 3,
		width = popUpFrame.width - 2,
		height = rows,
		attr = BG_BLACK | WHITE,
		parent = popUpFrame)
	var headers = mb.get_msg_header(msgNum);
	var subject = headers.subject;
	log('MSG HEADERS: ' + JSON.stringify(headers));
	//[RED, YELLOW, GREEN, CYAN, BLUE, MAGENTA]
	var xPos = 1;
	var padding = 2;
	var xTitleAvailable = popUpFrame.width - subject - padding;
	var xTitleCalc = 1;
	var minTitleAvailable = 0
	var title = JSON.parse(JSON.stringify(subject))
	// TODO: fill in the calculations for this if else block starting on line 264 and ending on line 269
	if (xTitleAvailable < minTitleAvailable) {
		// trim the string so it fits and adjust xTitleCalc so that string is centered.
		title = title.substring(0, popUpFrame.width - padding);
	}
	xTitleCalc = parseInt(((popUpFrame.width - padding) - title.length) / 2)
	popUpFrame.drawBorder([RED, YELLOW, GREEN, CYAN, BLUE, MAGENTA], { text: headers.subject, attr: WHITE | BLACK, y: 1, x: xTitleCalc });

	popUpFrame.open();
	innerFrame.open();
	popUpFrame.gotoxy(1, 3);
	popUpFrame.center('\1m' + headers.date)
	innerFrame.gotoxy(2, 2);
	innerFrame.centerWrap('\1h\1w' + body);
	innerFrame.draw();
	popUpFrame.draw();
	innerFrame.centralize(popUpFrame);
	containerFrame.cycle();
	if (hotspotsAvailable)
		registerModalHotspots(popUpFrame);
	while (bbs.online) {
		var key = console.getkey();
		if (key === KEY_ESC || key === KEY_ABORT || key === "\r" || key === "\n" || key === modalHotspotKey)
			break;
	}
	popUpFrame.close();
	popUpFrame.delete();
	if (hotspotsAvailable)
		registerTreeHotspots();
	refreshScreen();
}

msgTree.addItem("e|xit", exitMsgList);
mb.open();

for (var m = mb.last_msg; m >= mb.first_msg; m--) {

	var cursub2 = msg_area.grp_list[bbs.curgrp].sub_list[bbs.cursub].name;
	var curSubTotalMsgs = mb.total_msgs;
	var groupDescription = msg_area.grp_list[bbs.curgrp].description.substring(0, 40);

	var header = mb.get_msg_header(m);
	if (header === null || header.attr & MSG_DELETE)
		continue;
	var msgTime = system.timestr(header.when_written_time);
	log('msg Time ' + msgTime);
	var msgTimeTrim = msgTime.substr(4, 11);
	msgTimeTrim = msgTimeTrim.replace(" ", "");
	msgTime = msgTimeTrim;
	var msgSubj = new String;  //creates a string to hold the full message subject
	msgSubj = header.subject; //puts the value of the message subject in the variable
	var presubjLen = 14;
	var subjLen = 80 - presubjLen;  //creates a variable to create the width of subject without spilling to a new line
	var msgSubjTrim = msgSubj.substr(0, subjLen);
	var headerIndex = header.number;
	var concatDisplay = '|' + headerIndex + '. ' + msgTime + ' - ' + msgSubjTrim;
	msgTree.addItem(concatDisplay, readMessage, headerIndex);
}





var runSwitch = 1;

function exitMsgList() {
	runSwitch = 0;
}
msgTree.open();
headerFrame.open();
headerFrame.load(bannerLocation);
headerFrame.draw();
headerFrame.scroll(0, -1);
headerFrame.cycle();
msgBoardFrame.open();
msgBoardFrame.draw();
registerTreeHotspots();

while (runSwitch == 1) {
	var key = console.inkey(K_NONE, 25);
	var handled = false;
	if (key) {
		if (hotspotsAvailable) {
			var clickedRow = hotspotRowFromKey(key);
			if (clickedRow >= 0) {
				selectTreeRowByOffset(clickedRow);
				handled = true;
			} else if (key === modalHotspotKey) {
				handled = true;
			}
		}
		if (!handled)
			msgTree.getcmd(key);
	}
	msgTree.cycle();
}

if (hotspotsAvailable)
	clearHotspots();
mb.close();

function refreshScreen() {
	msgBoardFrame.invalidate();
	msgBoardFrame.open();
	msgBoardFrame.draw();
	headerFrame.invalidate();
	headerFrame.open();
	headerFrame.draw();
	registerTreeHotspots();
}

function stringChunk(n) {
	var ret = [];
	for (var i = 0, len = this.length; i < len; i += n) {
		ret.push(this.substr(i, n))
	}
	return ret
};

function switchMsgAreas() {
	return;
}



