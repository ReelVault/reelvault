/** Ordered browser markers — the first match wins. */
const BROWSER_MARKERS: ReadonlyArray<readonly [marker: string, browser: string]> = [
	["Firefox/", "firefox"],
	["Edg/", "edge"],
	["Chrome/", "chrome"],
	["Safari/", "safari"],
];

/** Ordered platform rules — the first match wins; the client code may inspect
 * the whole user agent (Android TV vs mobile). */
const PLATFORM_RULES: ReadonlyArray<{
	markers: readonly string[];
	os: string;
	client: (ua: string) => string;
}> = [
	{ markers: ["Android"], os: "android", client: (ua) => (ua.includes("TV") ? "android_tv" : "android_mobile") },
	{ markers: ["iPhone", "iPad"], os: "ios", client: () => "apple_ios" },
	{ markers: ["Windows"], os: "windows", client: () => "windows_pc" },
	{ markers: ["Macintosh", "Mac OS"], os: "macos", client: () => "apple_mac" },
	{ markers: ["Linux"], os: "linux", client: () => "linux_pc" },
];

/** Returns stable codes; the frontend maps them to localized labels. */
export function parseUserAgent(ua?: string | null): { clientName: string; browser: string; os: string } {
	if (!ua) return { clientName: "unknown", browser: "unknown", os: "unknown" };

	let browser = "web";
	for (const [marker, value] of BROWSER_MARKERS) {
		if (ua.includes(marker)) {
			browser = value;

			break;
		}
	}

	for (const { markers, os, client } of PLATFORM_RULES) {
		if (markers.some((marker) => ua.includes(marker))) {
			return { clientName: client(ua), browser, os };
		}
	}

	return { clientName: "web", browser, os: "unknown" };
}
