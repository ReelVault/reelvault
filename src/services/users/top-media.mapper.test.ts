import { expect, test } from "bun:test";
import { useTimeZone } from "../../../tests/helpers/time-zone.helper";
import { toTopWatchedMedia } from "./top-media.mapper";

// West of UTC, midnight UTC on 1 January is still 31 December of the year before.
useTimeZone("America/New_York");

test("reports the release year written in the date for a title released on 1 January", () => {
	const media = toTopWatchedMedia({
		id: "m1",
		title: "New Year Movie",
		type: "movie",
		releaseDate: "2020-01-01",
		posterImageId: null,
		posterImageUpdatedAt: null,
		totalDurationWatched: 5400,
		watchCount: 1,
		isCompleted: true,
	});

	expect(media).toMatchObject({ releaseYear: 2020, minutes: 90 });
});
