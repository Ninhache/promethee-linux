'use strict';
// Replaces active-win's lib/linux.js (build.sh moves the original to x11.js).
// xprop only sees XWayland windows, so on Wayland the focused window is asked to the compositor.
// Supported: Hyprland (hyprctl) and sway (swaymsg). Anything else falls back to the X11 code.
const childProcess = require('child_process');
const fs = require('fs');
const x11 = require('./x11.js');

// The app polls every few seconds: a hung compositor call must not stall it.
const TIMEOUT_MS = 1000;

// Hyprland: `hyprctl activewindow -j` prints the focused window, or {} when there is none.
const fromHyprland = w => w && w.pid > 0 ? {
	id: Number.parseInt(w.address, 16),
	title: w.title,
	name: w.class || w.initialClass,
	pid: w.pid,
	bounds: {x: w.at[0], y: w.at[1], width: w.size[0], height: w.size[1]}
} : undefined;

// sway: walk `swaymsg -t get_tree` to the focused leaf. Native apps have app_id, XWayland ones a class.
const fromSway = tree => {
	const stack = [tree];
	while (stack.length > 0) {
		const n = stack.pop();
		if (n.focused && n.pid > 0) {
			return {
				id: n.id,
				title: n.name,
				name: n.app_id || n.window_properties?.class,
				pid: n.pid,
				bounds: n.rect
			};
		}
		stack.push(...(n.nodes || []), ...(n.floating_nodes || []));
	}
};

const compositor = () => {
	if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
		return {cmd: 'hyprctl', args: ['activewindow', '-j'], parse: fromHyprland};
	}
	if (process.env.SWAYSOCK) {
		return {cmd: 'swaymsg', args: ['-t', 'get_tree'], parse: fromSway};
	}
};

// Same shape as active-win's X11 result, which is what the app reads (owner.name, owner.path, title).
const toResult = (w, memoryUsage, path) => ({
	platform: 'linux',
	title: w.title || null,
	id: w.id,
	owner: {name: w.name || 'Unknown', processId: w.pid, path},
	bounds: w.bounds,
	memoryUsage
});

const memoryUsageSync = pid => {
	try {
		return Number.parseInt(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1], 10) * 4096;
	} catch {}
};

const pathSync = pid => {
	try {
		return fs.readlinkSync(`/proc/${pid}/exe`);
	} catch {}
};

module.exports = async options => {
	const c = compositor();
	if (!c) {
		return x11(options);
	}
	try {
		const stdout = await new Promise((resolve, reject) => {
			childProcess.execFile(c.cmd, c.args, {timeout: TIMEOUT_MS, encoding: 'utf8'},
				(error, out) => error ? reject(error) : resolve(out));
		});
		const w = c.parse(JSON.parse(stdout));
		return w && toResult(w, memoryUsageSync(w.pid), pathSync(w.pid));
	} catch {
		// Compositor tool missing or failed: XWayland windows are still visible to xprop.
		return x11(options);
	}
};

module.exports.sync = options => {
	const c = compositor();
	if (!c) {
		return x11.sync(options);
	}
	try {
		const stdout = childProcess.execFileSync(c.cmd, c.args, {timeout: TIMEOUT_MS, encoding: 'utf8'});
		const w = c.parse(JSON.parse(stdout));
		return w && toResult(w, memoryUsageSync(w.pid), pathSync(w.pid));
	} catch {
		return x11.sync(options);
	}
};
