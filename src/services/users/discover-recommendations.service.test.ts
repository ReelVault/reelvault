import { beforeEach, describe, expect, test } from "bun:test";
import { schema } from "@/integrations/drizzle-orm/database.schema";
import { clearRecommendationFeatureStats } from "@/repositories/discover-recommendations.reader";
import {
	insertEpisodes,
	insertGenres,
	insertLibraries,
	insertMediaFiles,
	insertMetadata,
	insertProfiles,
	insertSeasons,
	insertUserRatings,
	insertUsers,
	insertWatchedHistory,
	type TestClient,
} from "../../../tests/helpers/rows.fixture";
import { useTestDatabase } from "../../../tests/helpers/test-database.helper";
import { buildRecommendations } from "./discover-recommendations.service";

const db = useTestDatabase();

const PROFILE_ID = "reported-profile";
const LATEST_MAX = 1_795_131_112;
const WATCH_MAX = 1_795_286_296;

interface TitleFixture {
	id: string;
	title: string;
	type: "movie" | "tv_show";
	releaseDate: string;
	popularity: number;
	latest: number;
	created: number;
	genres: string[];
	keywords: string[];
	cast: Array<[string, number]>;
	crew: Array<[string, string]>;
	rating: [number, number];
}

/** Real library rows: ids, titles, dates, popularity, tags, crew, ratings and recency. */
const TITLES: TitleFixture[] = [
	{
		id: "01a0162a-f80a-7014-8519-68d94cfa1d2f",
		title: "American Horror Story",
		type: "tv_show",
		releaseDate: "2011-10-05",
		popularity: 106.8747,
		latest: 1791406916,
		created: 1787078309,
		genres: ["Dramat", "Tajemnica", "Sci-Fi & Fantasy"],
		keywords: [
			"supernatural",
			"apocalypse",
			"supernatural horror",
			"hotel",
			"1980s",
			"slasher",
			"school of witchcraft",
			"virus",
			"serial killer",
			"lgbt",
			"cult",
			"paranormal activity",
			"asylum",
			"horror",
			"witchcraft",
			"haunted house",
			"carnival",
			"psychological horror",
			"coven (akelarre)",
			"nun",
			"witches",
			"presidential election",
			"anthology",
			"summer camp",
			"freak show",
			"period piece",
			"anti-christ",
			"erotic thriller",
			"horror anthology",
		],
		cast: [],
		crew: [
			["Eric Kovtun", "Executive Producer"],
			["Crystle Roberson Dorsey", "Executive Producer"],
			["Tim Minear", "Executive Producer"],
			["Tanase Popa", "Executive Producer"],
			["Jennifer Salt", "Executive Producer"],
			["Charlie Carver", "Executive Producer"],
			["Scott Robertson", "Executive Producer"],
			["Brad Falchuk", "Executive Producer"],
			["Ryan Murphy", "Executive Producer"],
			["Nissa Diederich", "Executive Producer"],
			["Ned Martel", "Executive Producer"],
		],
		rating: [8.075, 6146],
	},
	{
		id: "01a0165e-b59e-7615-923b-ba79fa19014d",
		title: "Atypowy",
		type: "tv_show",
		releaseDate: "2017-08-11",
		popularity: 14.6017,
		latest: 1787081765,
		created: 1787081700,
		genres: ["Dramat", "Komedia"],
		keywords: [
			"dramatic",
			"doubtful",
			"high school",
			"wonder",
			"sentimental",
			"family relationships",
			"coming of age",
			"lgbt",
			"teenager",
			"autism",
			"thoughtful",
			"curious",
			"teenage protagonist",
			"parenthood",
			"lighthearted",
			"connecticut",
			"heartfelt",
			"autistic",
		],
		cast: [
			["Keir Gilchrist", 0],
			["Jennifer Jason Leigh", 1],
			["Jack Haven", 2],
			["Michael Rapaport", 3],
		],
		crew: [
			["Robia Rashid", "Executive Producer"],
			["Seth Gordon", "Executive Producer"],
		],
		rating: [8.016, 1268],
	},
	{
		id: "01a1dc3d-70fc-77b1-b1ab-f5d2c0802965",
		title: "Campus Drivers",
		type: "tv_show",
		releaseDate: "2026-11-06",
		popularity: 153.9062,
		latest: 1794696377,
		created: 1794696376,
		genres: ["Dramat"],
		keywords: [
			"university",
			"romance",
			"cars",
			"college",
			"racing",
			"ex-boyfriend ex-girlfriend relationship",
			"south of france",
			"roommates to lovers",
			"forced proximity",
		],
		cast: [
			["Carmen Kassovitz", 0],
			["Baptiste Masseline", 1],
			["Esteban Vial", 2],
			["Félix Nebel", 3],
			["Madior Fall", 4],
		],
		crew: [
			["Tom Goris", "Director"],
			["Vianney Lebasque", "Director"],
		],
		rating: [7.868, 38],
	},
	{
		id: "01a01691-eaf8-720f-b7a0-a5619f945cee",
		title: "Cień i kość",
		type: "tv_show",
		releaseDate: "2021-04-23",
		popularity: 14.0221,
		latest: 1787085088,
		created: 1787085056,
		genres: ["Dramat", "Sci-Fi & Fantasy"],
		keywords: [
			"based on novel or book",
			"soldier",
			"magic",
			"based on young adult novel",
			"based on myths, legends or folklore",
			"teenager",
			"fantasy",
			"adventure",
			"power",
			"crew",
			"young woman",
			"middle ages",
			"darkling",
		],
		cast: [
			["Jessie Mei Li", 0],
			["Archie Renaux", 1],
			["Freddy Carter", 2],
			["Amita Suman", 3],
			["Kit Young", 4],
		],
		crew: [
			["Pouya Shahbazian", "Executive Producer"],
			["Josh Barry", "Executive Producer"],
			["Shawn Levy", "Executive Producer"],
			["Dan Levine", "Executive Producer"],
			["Dan Cohen", "Executive Producer"],
			["Eric Heisserer", "Executive Producer"],
			["Leigh Bardugo", "Executive Producer"],
		],
		rating: [7.749, 1606],
	},
	{
		id: "01a01607-59cd-74e4-86ca-45bce8767088",
		title: "Dr House",
		type: "tv_show",
		releaseDate: "2004-11-16",
		popularity: 168.3187,
		latest: 1787076293,
		created: 1787075975,
		genres: ["Dramat"],
		keywords: [
			"taunting",
			"doctor",
			"excited",
			"disease",
			"hospital",
			"medicine",
			"medical drama",
			"drug addiction",
			"rare disease",
			"illness",
			"misanthrophy",
			"thought provoking",
			"patient",
			"colleague",
			"diagnosis",
			"medical",
			"medical ethics",
			"drug addict",
			"symptom",
			"tortured genius",
		],
		cast: [
			["Hugh Laurie", 0],
			["Robert Sean Leonard", 2],
			["Omar Epps", 3],
		],
		crew: [
			["Russel Friend", "Executive Producer"],
			["Thomas L. Moran", "Executive Producer"],
			["Hugh Laurie", "Executive Producer"],
			["Peter Blake", "Executive Producer"],
			["Garrett Lerner", "Executive Producer"],
			["Katie Jacobs", "Executive Producer"],
			["Bryan Singer", "Executive Producer"],
			["Paul Attanasio", "Executive Producer"],
			["David Shore", "Executive Producer"],
		],
		rating: [8.565, 7842],
	},
	{
		id: "01a0167b-eb2d-732a-9380-814bdaf07135",
		title: "Euforia",
		type: "tv_show",
		releaseDate: "2019-06-16",
		popularity: 81.9039,
		latest: 1787083657,
		created: 1787083615,
		genres: ["Dramat"],
		keywords: [
			"euphoric",
			"female protagonist",
			"sexual freedom",
			"coming of age",
			"bold",
			"high school student",
			"teenage girl",
			"drug use",
			"trans woman",
			"sex addiction",
			"sex scandal",
			"transgender",
			"addiction",
			"childhood trauma",
			"drug crime",
			"2010s",
			"attention deficit hyperactivity disorder (adhd)",
			"relationship problems",
			"generation z",
			"abusive family",
			"drug rehabilitation",
			"peer pressure",
			"love-hate relationship",
			"painful memories",
			"pornography addiction",
			"trans youth",
			"addiction recovery",
		],
		cast: [
			["Zendaya", 0],
			["Hunter Schafer", 1],
			["Sydney Sweeney", 2],
			["Jacob Elordi", 3],
			["Alexa Demie", 4],
		],
		crew: [
			["Ashley Levinson", "Executive Producer"],
			["Sam Levinson", "Executive Producer"],
			["Yoram Mokady", "Executive Producer"],
			["Adel 'Future' Nur", "Executive Producer"],
			["Drake", "Executive Producer"],
			["Ravi Nandan", "Executive Producer"],
			["Sara E. White", "Executive Producer"],
			["דפנה לוין", "Executive Producer"],
			["Ron Leshem", "Executive Producer"],
			["Gary Lennon", "Executive Producer"],
			["Hadas Mozes Lichtenstein", "Executive Producer"],
			["Tmira Yardeni", "Executive Producer"],
			["Kevin Turen", "Executive Producer"],
			["מירית טובי", "Executive Producer"],
		],
		rating: [8.276, 11048],
	},
	{
		id: "01a1dc3d-6074-763a-b87a-c0c0442abfb8",
		title: "Każdy kolejny rok",
		type: "tv_show",
		releaseDate: "2026-06-10",
		popularity: 10.9082,
		latest: 1794696373,
		created: 1794696372,
		genres: ["Dramat"],
		keywords: ["based on novel or book", "romance", "wonder", "lighthearted", "first love"],
		cast: [
			["Sadie Soverall", 0],
			["Matt Cornett", 1],
			["Aurora Perrineau", 2],
			["Abigail Cowen", 3],
			["Michael Bradway", 4],
		],
		crew: [
			["Lindsey Liberatore", "Executive Producer"],
			["Amy Rardin", "Executive Producer"],
			["Grace Gilroy", "Executive Producer"],
			["Carley Fortune", "Executive Producer"],
			["Amy Harris", "Executive Producer"],
			["John Stephens", "Executive Producer"],
		],
		rating: [8.167, 108],
	},
	{
		id: "01a026da-6565-72f3-8f8a-cdd12c780e62",
		title: "Latarnie",
		type: "tv_show",
		releaseDate: "2026-08-16",
		popularity: 309.0675,
		latest: 1790811605,
		created: 1787358242,
		genres: ["Dramat", "Tajemnica", "Sci-Fi & Fantasy"],
		keywords: [
			"based on comic",
			"superhero",
			"buddy cop",
			"super power",
			"murder investigation",
			"2020s",
			"small town",
			"multiple storylines",
			"ex-marine",
			"2010s",
			"dc universe (dcu)",
			"recruit",
			"nebraska",
			"trainee",
			"willpower",
			"mentor-mentee relationship",
		],
		cast: [
			["Kyle Chandler", 0],
			["Aaron Pierre", 1],
			["Kelly Macdonald", 2],
			["Garret Dillahunt", 3],
			["Poorna Jagannathan", 4],
		],
		crew: [
			["Damon Lindelof", "Executive Producer"],
			["James Hawes", "Executive Producer"],
			["Chris Mundy", "Executive Producer"],
			["James Gunn", "Executive Producer"],
			["Ron Schmidt", "Executive Producer"],
			["Peter Safran", "Executive Producer"],
			["Tom King", "Executive Producer"],
		],
		rating: [8.279, 235],
	},
	{
		id: "01a01531-6568-72cc-8fa9-a8e682367add",
		title: "Motorheads",
		type: "tv_show",
		releaseDate: "2025-05-20",
		popularity: 6.6491,
		latest: 1788791159,
		created: 1787061953,
		genres: ["Dramat"],
		keywords: ["dramatic", "exhilarated", "romantic", "suspenseful", "nostalgic", "intimate", "rust belt", "commanding", "street racing"],
		cast: [
			["Michael Cimino", 0],
			["Ryan Phillippe", 1],
			["Nathalie Kelley", 2],
			["Deacon Phillippe", 3],
			["Melissa Collazo", 4],
		],
		crew: [
			["Neil Burger", "Executive Producer"],
			["Jason Seagraves", "Executive Producer"],
			["Ruben Fleischer", "Executive Producer"],
			["Keegan Rosenberger", "Executive Producer"],
			["John A. Norris", "Executive Producer"],
			["Dana Brunetti", "Executive Producer"],
		],
		rating: [8.396, 101],
	},
	{
		id: "01a1dc3d-5b17-758a-9c67-3fd00f31cc54",
		title: "Off Campus",
		type: "tv_show",
		releaseDate: "2026-05-13",
		popularity: 40.4471,
		latest: 1794696372,
		created: 1794696370,
		genres: ["Dramat"],
		keywords: ["based on novel or book", "romance", "love", "romantic", "compassionate", "self-discovery"],
		cast: [
			["Ella Bright", 0],
			["Belmont Cameli", 1],
			["Mika Abdalla", 2],
			["Stephen Kalyn", 3],
			["Jalen Thomas Brooks", 4],
		],
		crew: [
			["Marty Bowen", "Executive Producer"],
			["Louisa Levy", "Executive Producer"],
			["Wyck Godfrey", "Executive Producer"],
			["Gina Fattore", "Executive Producer"],
			["Neal Flaherty", "Executive Producer"],
			["James Seidman", "Executive Producer"],
			["Leanna Billings", "Executive Producer"],
			["Silver Tree", "Executive Producer"],
		],
		rating: [8.844, 914],
	},
	{
		id: "01a01683-2360-773e-97fb-969013aac5e9",
		title: "Outer Banks",
		type: "tv_show",
		releaseDate: "2020-04-15",
		popularity: 164.0754,
		latest: 1794696358,
		created: 1787084088,
		genres: ["Tajemnica", "Akcja i Przygoda"],
		keywords: [
			"boat chase",
			"on the run",
			"teenager",
			"illegal drugs",
			"treasure hunt",
			"diving",
			"adventure",
			"exciting",
			"north carolina",
			"surfing",
			"outer banks",
		],
		cast: [
			["Chase Stokes", 0],
			["Madelyn Cline", 1],
			["Madison Bailey", 2],
			["Jonathan Daviss", 3],
			["Carlacia Grant", 4],
		],
		crew: [
			["Jonas Pate", "Executive Producer"],
			["Josh Pate", "Executive Producer"],
			["Shannon Burke", "Executive Producer"],
		],
		rating: [8.244, 1252],
	},
	{
		id: "01a01671-d2e0-7048-a8f8-e75b8cc07d7b",
		title: "Rezydenci",
		type: "tv_show",
		releaseDate: "2018-01-21",
		popularity: 46.3313,
		latest: 1787083129,
		created: 1787082953,
		genres: ["Dramat"],
		keywords: ["doctor", "hospital", "medical drama", "medical resident"],
		cast: [
			["Matt Czuchry", 0],
			["Manish Dayal", 2],
			["Malcolm-Jamal Warner", 4],
		],
		crew: [
			["Roshan Sethi", "Creator"],
			["Hayley Schore", "Creator"],
			["Amy Holden Jones", "Executive Producer"],
		],
		rating: [8.4, 1335],
	},
	{
		id: "01a0167a-b403-70fa-ae43-e7e42e019b98",
		title: "Sex Education",
		type: "tv_show",
		releaseDate: "2019-01-11",
		popularity: 58.2932,
		latest: 1787083594,
		created: 1787083535,
		genres: ["Dramat", "Komedia"],
		keywords: [
			"high school",
			"absurd",
			"coming of age",
			"school",
			"sex comedy",
			"lgbt",
			"gay theme",
			"england",
			"teenager",
			"small town",
			"candid",
			"witty",
			"teenage protagonist",
			"lgbt teen",
			"bittersweet",
			"teenage sexuality",
			"sex therapy",
			"black lgbt",
			"sex therapist",
			"asexuality",
		],
		cast: [
			["Asa Butterfield", 0],
			["Gillian Anderson", 1],
			["Ncuti Gatwa", 2],
			["Emma Mackey", 3],
			["Kedar Williams-Stirling", 4],
		],
		crew: [
			["Laurie Nunn", "Executive Producer"],
			["Ben Taylor", "Executive Producer"],
			["Clare Couchman", "Executive Producer"],
			["Jamie Campbell", "Executive Producer"],
		],
		rating: [8.194, 7978],
	},
	{
		id: "01a01628-320f-74ae-9cc0-a497278db024",
		title: "Sherlock",
		type: "tv_show",
		releaseDate: "2010-07-25",
		popularity: 38.0516,
		latest: 1787078143,
		created: 1787078128,
		genres: ["Dramat", "Kryminał", "Tajemnica"],
		keywords: [
			"based on novel or book",
			"amused",
			"murder",
			"friendship",
			"london, england",
			"police",
			"suspenseful",
			"investigation",
			"doctor",
			"workaholic",
			"detective",
			"urgent",
			"sherlock holmes",
			"ambiguous",
			"tense",
			"whodunit",
			"genius",
			"private detective",
			"murder mystery",
			"police procedural",
			"cerebral",
			"tortured genius",
			"army medic",
			"deduction",
			"sharp",
		],
		cast: [
			["Benedict Cumberbatch", 0],
			["Martin Freeman", 1],
		],
		crew: [
			["Beryl Vertue", "Executive Producer"],
			["Bethan Jones", "Executive Producer"],
			["Steven Moffat", "Executive Producer"],
			["Rebecca Eaton", "Executive Producer"],
			["Mark Gatiss", "Executive Producer"],
		],
		rating: [8.508, 6668],
	},
	{
		id: "01a026d9-d1cf-706b-8cc1-993b025382fd",
		title: "SkyMed",
		type: "tv_show",
		releaseDate: "2022-07-10",
		popularity: 8.6669,
		latest: 1787358224,
		created: 1787358204,
		genres: ["Dramat"],
		keywords: ["medical drama"],
		cast: [
			["Natasha Calis", 0],
			["Morgan Holmstrom", 1],
			["Aaron Ashmore", 2],
			["Mercedes Morris", 3],
		],
		crew: [],
		rating: [6.661, 93],
	},
	{
		id: "01a015af-f861-728f-a6e8-98d6a51e8e5b",
		title: "Special Ops: Lioness",
		type: "tv_show",
		releaseDate: "2023-07-23",
		popularity: 348.021,
		latest: 1790047974,
		created: 1787070249,
		genres: ["Dramat", "War & Politics"],
		keywords: [
			"central intelligence agency (cia)",
			"undercover agent",
			"spy thriller",
			"biting",
			"thoughtful",
			"us military",
			"special ops",
		],
		cast: [
			["Zoe Saldaña", 0],
			["Laysla De Oliveira", 1],
			["Dave Annable", 2],
			["Jill Wagner", 3],
			["LaMonica Garrett", 4],
		],
		crew: [
			["Taylor Sheridan", "Executive Producer"],
			["Jill Wagner", "Executive Producer"],
			["Zoe Saldaña", "Executive Producer"],
			["David Lemanowicz", "Executive Producer"],
			["Nicole Kidman", "Executive Producer"],
			["David Hutkin", "Executive Producer"],
			["David C. Glasser", "Executive Producer"],
			["Geyer Kosinski", "Executive Producer"],
			["Michael Friedman", "Executive Producer"],
			["Bob Yari", "Executive Producer"],
			["Ron Burkle", "Executive Producer"],
		],
		rating: [8.121, 1459],
	},
	{
		id: "01a014dd-6df5-703e-b122-e25c8d4c07dc",
		title: "Spider-Noir",
		type: "tv_show",
		releaseDate: "2026-05-25",
		popularity: 29.992,
		latest: 1790811606,
		created: 1787056451,
		genres: ["Dramat", "Kryminał", "Tajemnica", "Akcja i Przygoda"],
		keywords: [
			"based on comic",
			"new york city",
			"superhero",
			"euphoric",
			"detective",
			"great depression",
			"private investigator",
			"admiring",
			"femme fatale",
			"mysterious",
			"1930s",
			"period drama",
			"mobster",
			"supervillain",
			"black and white",
			"film noir",
		],
		cast: [
			["Nicolas Cage", 0],
			["Lamorne Morris", 1],
			["Li Jun Li", 2],
			["Karen Rodriguez", 3],
			["Abraham Popoola", 4],
		],
		crew: [
			["Dan Shear", "Executive Producer"],
			["Christopher Miller", "Executive Producer"],
			["Oren Uziel", "Executive Producer"],
			["Nicolas Cage", "Executive Producer"],
			["Steve Lightfoot", "Executive Producer"],
			["Phil Lord", "Executive Producer"],
			["Amy Pascal", "Executive Producer"],
			["Aditya Sood", "Executive Producer"],
			["Pavlina Hatoupis", "Executive Producer"],
		],
		rating: [8.357, 813],
	},
	{
		id: "01a05e82-b376-76e1-9437-ab8ea5c71e7e",
		title: "Sterling Point",
		type: "tv_show",
		releaseDate: "2026-08-05",
		popularity: 54.7316,
		latest: 1788292052,
		created: 1788292019,
		genres: ["Dramat", "Tajemnica"],
		keywords: ["compassionate", "toronto, canada", "ontario, canada", "romantic drama", "long lost sibling"],
		cast: [
			["Ella Rubin", 0],
			["Amélie Hoeferle", 1],
			["Bo Bragason", 2],
			["Jacob Whiteduck-Lavoie", 3],
			["Daniel Quinn-Toye", 4],
		],
		crew: [
			["Tom Ackerley", "Executive Producer"],
			["Dani Gorin", "Executive Producer"],
			["Megan Park", "Executive Producer"],
			["Josh Schwartz", "Executive Producer"],
			["Stephanie Savage", "Executive Producer"],
		],
		rating: [8.211, 121],
	},
	{
		id: "01a011b3-5add-7028-be20-1597c8fa772a",
		title: "Szósty zmysł",
		type: "movie",
		releaseDate: "1999-08-06",
		popularity: 31.0151,
		latest: 1787003365,
		created: 1787003362,
		genres: ["Dramat", "Thriller", "Tajemnica"],
		keywords: [
			"dramatic",
			"supernatural horror",
			"anxious",
			"paranormal phenomena",
			"ghost",
			"loss of loved one",
			"afterlife",
			"suspenseful",
			"somber",
			"psychological thriller",
			"child abuse",
			"dying and death",
			"marriage crisis",
			"philadelphia, pennsylvania",
			"single mother",
			"kids",
			"psychological horror",
			"single",
			"spiritism",
			"sense of guilt",
			"ghost child",
			"psychology",
			"cowardliness",
			"confidence",
			"school play",
			"supernatural thriller",
		],
		cast: [
			["Bruce Willis", 0],
			["Haley Joel Osment", 1],
			["Toni Collette", 2],
			["Olivia Williams", 3],
			["Trevor Morgan", 4],
		],
		crew: [
			["M. Night Shyamalan", "Director"],
			["M. Night Shyamalan", "Writer"],
			["Sam Mercer", "Executive Producer"],
		],
		rating: [7.954, 13323],
	},
	{
		id: "01a1f626-b39f-716d-82de-4ece15a2567f",
		title: "Słodkie kłamstewka: Perfekcjonistki",
		type: "tv_show",
		releaseDate: "2019-03-20",
		popularity: 4.1485,
		latest: 1795131112,
		created: 1795131093,
		genres: ["Dramat", "Kryminał", "Tajemnica"],
		keywords: ["young adult", "based on young adult novel", "college", "spin off"],
		cast: [
			["Sasha Pieterse", 0],
			["Janel Parrish", 1],
			["Sofia Carson", 2],
			["Sydney Park", 3],
			["Eli Brown", 4],
		],
		crew: [
			["I. Marlene King", "Executive Producer"],
			["Gina Girolamo", "Executive Producer"],
			["Leslie Morgenstein", "Executive Producer"],
			["Lisa Cochran-Neilan", "Executive Producer"],
			["Charles Grant Craig", "Executive Producer"],
		],
		rating: [7.744, 508],
	},
	{
		id: "01a01666-6518-72fe-b39b-9bc8be846925",
		title: "The Good Doctor",
		type: "tv_show",
		releaseDate: "2017-09-25",
		popularity: 106.8934,
		latest: 1787082395,
		created: 1787082204,
		genres: ["Dramat"],
		keywords: [
			"remake",
			"nurse",
			"san francisco, california",
			"hospital",
			"autism",
			"asperger's syndrome",
			"medicine",
			"medical drama",
			"based on tv series",
			"cliché",
			"medical",
		],
		cast: [
			["Freddie Highmore", 0],
			["Fiona Gubelmann", 1],
			["Will Yun Lee", 3],
			["Christina Chang", 4],
		],
		crew: [
			["Erin Gunn", "Executive Producer"],
			["Sebastian Lee", "Executive Producer"],
			["David Kim", "Executive Producer"],
			["Daniel Dae Kim", "Executive Producer"],
			["Mike Listo", "Executive Producer"],
			["David Shore", "Executive Producer"],
		],
		rating: [8.454, 12918],
	},
	{
		id: "01a01687-f7a4-721c-b792-927339dd5b24",
		title: "Utopia Falls",
		type: "tv_show",
		releaseDate: "2020-02-14",
		popularity: 3.3041,
		latest: 1787084420,
		created: 1787084404,
		genres: ["Dramat", "Sci-Fi & Fantasy"],
		keywords: ["dystopia", "competition", "distant future"],
		cast: [
			["Robyn Alomar", 0],
			["Robbie G.K.", 1],
			["Phillip Forest Lewitski", 2],
			["Akiel Julien", 3],
			["Humberly González", 4],
		],
		crew: [
			["Mellit Orr", "Director"],
			["R.T. Thorne", "Director"],
			["R.T. Thorne", "Executive Producer"],
			["R.T. Thorne", "Writer"],
			["Joseph Mallozzi", "Executive Producer"],
			["Warren P. Sonoda", "Director"],
		],
		rating: [7.147, 58],
	},
	{
		id: "01a01131-db7f-7730-81a6-c0aa9b03dc5a",
		title: "Wyspa tajemnic",
		type: "movie",
		releaseDate: "2010-02-14",
		popularity: 25.6283,
		latest: 1789394967,
		created: 1786994875,
		genres: ["Dramat", "Thriller", "Tajemnica"],
		keywords: [
			"based on novel or book",
			"complex",
			"intense",
			"philosophical",
			"island",
			"concentration camp",
			"hurricane",
			"investigation",
			"psychiatric hospital",
			"mental institution",
			"escaped patient",
			"psychologist",
			"psychological thriller",
			"doctor",
			"missing person",
			"ex military",
			"neo-noir",
			"criminally insane",
			"1950s",
			"haunting past",
			"visions",
			"mystery",
			"depressing",
			"dachau",
			"inspirational",
		],
		cast: [
			["Leonardo DiCaprio", 0],
			["Mark Ruffalo", 1],
			["Ben Kingsley", 2],
			["Max von Sydow", 3],
			["Michelle Williams", 4],
		],
		crew: [
			["Martin Scorsese", "Director"],
			["Dennis Lehane", "Executive Producer"],
			["Gianni Nunnari", "Executive Producer"],
			["Laeta Kalogridis", "Executive Producer"],
			["Laeta Kalogridis", "Screenplay"],
			["Louis Phillips", "Executive Producer"],
			["Chris Brigham", "Executive Producer"],
		],
		rating: [8.197, 26399],
	},
	{
		id: "01a015af-99c5-74ec-92d6-e38307db5abf",
		title: "XO, Kitty",
		type: "tv_show",
		releaseDate: "2023-05-18",
		popularity: 25.7164,
		latest: 1787070235,
		created: 1787070224,
		genres: ["Dramat", "Komedia"],
		keywords: [
			"based on novel or book",
			"amused",
			"romance",
			"high school",
			"romcom",
			"lgbt",
			"gay theme",
			"hilarious",
			"loving",
			"teenager",
			"high school student",
			"spin off",
			"baffled",
			"first love",
			"seoul, south korea",
			"korean",
			"embarrassed",
			"study abroad",
			"international student",
			"campus romance",
			"charming",
		],
		cast: [
			["Anna Cathcart", 0],
			["최민영", 1],
			["Gia Kim", 2],
			["이상헌", 3],
			["Anthony Keyvan", 4],
		],
		crew: [],
		rating: [8.053, 696],
	},
	{
		id: "01a01144-cd16-70cf-9f44-aee6900db715",
		title: "Zaginiona dziewczyna",
		type: "movie",
		releaseDate: "2014-10-01",
		popularity: 27.0243,
		latest: 1789395040,
		created: 1786996116,
		genres: ["Dramat", "Thriller", "Tajemnica"],
		keywords: [
			"based on novel or book",
			"investigation",
			"psychological thriller",
			"missing person",
			"cynical",
			"disappearance",
			"infidelity",
			"marriage crisis",
			"wife",
			"whodunit",
			"search party",
			"criminal lawyer",
			"murder suspect",
			"missing wife",
			"perspective",
			"manipulative woman",
			"toxic relationship",
			"revenge thriller",
			"killed during sex",
			"hate",
			"controlling wife",
		],
		cast: [
			["Ben Affleck", 0],
			["Rosamund Pike", 1],
			["Neil Patrick Harris", 2],
			["Tyler Perry", 3],
			["Carrie Coon", 4],
		],
		crew: [
			["Leslie Dixon", "Executive Producer"],
			["Bruna Papandrea", "Executive Producer"],
			["Gillian Flynn", "Screenplay"],
			["David Fincher", "Director"],
		],
		rating: [7.89, 20374],
	},
];

interface WatchedShow {
	titleId: string;
	seasons: number[];
	watched: number;
	watchRows: number;
	lastWatched: number;
	rating?: number;
}

/** Episode totals and watch counts of the reported profile, read from its library rows. */
const WATCHED: WatchedShow[] = [
	{ titleId: "01a026d9-d1cf-706b-8cc1-993b025382fd", seasons: [9, 9, 9, 8], watched: 25, watchRows: 26, lastWatched: 1794693854 },
	{ titleId: "01a01531-6568-72cc-8fa9-a8e682367add", seasons: [10], watched: 10, watchRows: 10, lastWatched: 1795097658 },
	{ titleId: "01a01687-f7a4-721c-b792-927339dd5b24", seasons: [10], watched: 10, watchRows: 10, lastWatched: 1794948754 },
	{ titleId: "01a1dc3d-70fc-77b1-b1ab-f5d2c0802965", seasons: [6], watched: 6, watchRows: 7, lastWatched: 1795286296, rating: 2 },
	{ titleId: "01a015af-f861-728f-a6e8-98d6a51e8e5b", seasons: [8, 8, 8], watched: 8, watchRows: 8, lastWatched: 1790367305, rating: 2 },
	{ titleId: "01a05e82-b376-76e1-9437-ab8ea5c71e7e", seasons: [8], watched: 8, watchRows: 10, lastWatched: 1788443598, rating: 2 },
];

function shifted(realSeconds: number, maxSeconds: number, nowMs: number): Date {
	return new Date(nowMs - (maxSeconds - realSeconds) * 1000);
}

function requireId(ids: ReadonlyMap<string, string>, name: string): string {
	const id = ids.get(name);
	if (!id) throw new Error(`Missing generated id for ${name}`);

	return id;
}

async function seedCatalog(client: TestClient, nowMs: number): Promise<void> {
	const genreNames = [...new Set(TITLES.flatMap((title) => title.genres))];
	const keywordNames = [...new Set(TITLES.flatMap((title) => title.keywords))];
	const personNames = [...new Set(TITLES.flatMap((title) => [...title.cast.map(([name]) => name), ...title.crew.map(([name]) => name)]))];
	const genreIds = new Map(genreNames.map((name, index) => [name, `genre-${index}`]));
	const keywordIds = new Map(keywordNames.map((name, index) => [name, `keyword-${index}`]));
	const peopleIds = new Map(personNames.map((name, index) => [name, `person-${index}`]));

	await insertGenres(
		client,
		genreNames.map((name) => ({ id: genreIds.get(name), stableKey: name, name })),
	);
	await client.insert(schema.keywords).values(keywordNames.map((name) => ({ id: keywordIds.get(name), stableKey: name, name })));
	await client.insert(schema.people).values(personNames.map((name) => ({ id: peopleIds.get(name), stableKey: name, name })));

	for (const title of TITLES) {
		await insertMetadata(client, {
			id: title.id,
			stableKey: title.id,
			title: title.title,
			type: title.type,
			releaseDate: title.releaseDate,
			popularity: title.popularity,
			latestMediaCreatedAt: shifted(title.latest, LATEST_MAX, nowMs),
			createdAt: new Date(title.created * 1000),
		});
		await client
			.insert(schema.metadataGenres)
			.values(title.genres.map((genre) => ({ metadataId: title.id, genreId: requireId(genreIds, genre) })));
		await client
			.insert(schema.metadataKeywords)
			.values(title.keywords.map((keyword) => ({ metadataId: title.id, keywordId: requireId(keywordIds, keyword) })));
		if (title.cast.length > 0) {
			await client.insert(schema.metadataCast).values(
				title.cast.map(([name, sortOrder]) => ({
					metadataId: title.id,
					personId: requireId(peopleIds, name),
					role: "Cast",
					sortOrder,
				})),
			);
		}
		if (title.crew.length > 0) {
			await client.insert(schema.metadataCrew).values(
				title.crew.map(([name, job]) => ({
					metadataId: title.id,
					personId: requireId(peopleIds, name),
					job,
					department: "Production",
				})),
			);
		}
		await client.insert(schema.metadataRatings).values({
			metadataId: title.id,
			source: "tmdb",
			value: title.rating[0],
			votes: title.rating[1],
		});
	}
}

async function seedProfileRows(client: TestClient): Promise<string> {
	await insertUsers(client, { id: "reported-user", name: "Reporter", email: "reporter@example.com", emailVerified: true });
	await insertProfiles(client, { id: PROFILE_ID, userId: "reported-user", name: "Reporter" });
	const [library] = await insertLibraries(client, { name: "Shows", type: "tv_shows" });
	if (!library) throw new Error("Expected the library to be inserted");

	return library.id;
}

async function seedEpisodeFiles(client: TestClient, show: WatchedShow, libraryId: string): Promise<string[]> {
	const fileIds: string[] = [];
	for (const [seasonIndex, episodeCount] of show.seasons.entries()) {
		const [season] = await insertSeasons(client, {
			stableKey: `${show.titleId}-s${seasonIndex + 1}`,
			metadataId: show.titleId,
			seasonNumber: seasonIndex + 1,
		});
		if (!season) throw new Error("Expected the season to be inserted");

		for (let episodeNumber = 1; episodeNumber <= episodeCount; episodeNumber += 1) {
			const [episode] = await insertEpisodes(client, {
				stableKey: `${season.id}-e${episodeNumber}`,
				seasonId: season.id,
				episodeNumber,
				episodeType: "regular",
			});
			if (!episode) throw new Error("Expected the episode to be inserted");

			const [file] = await insertMediaFiles(client, {
				libraryId,
				metadataId: show.titleId,
				episodeId: episode.id,
				filePath: `/tv/${show.titleId}/${season.id}-e${episodeNumber}.mkv`,
				fileName: `S${seasonIndex + 1}E${episodeNumber}.mkv`,
				duration: 1200,
			});
			if (!file) throw new Error("Expected the media file to be inserted");

			fileIds.push(file.id);
		}
	}

	return fileIds;
}

async function seedWatchRows(client: TestClient, show: WatchedShow, fileIds: readonly string[], nowMs: number): Promise<void> {
	const watchedAt = shifted(show.lastWatched, WATCH_MAX, nowMs);
	for (let index = 0; index < show.watchRows; index += 1) {
		const fileId = fileIds[index % show.watched];
		if (!fileId) throw new Error("Expected a watched media file");

		await insertWatchedHistory(client, {
			id: crypto.randomUUID(),
			mediaFileId: fileId,
			profileId: PROFILE_ID,
			durationWatched: 1200,
			isFullWatch: true,
			watchedAt,
			createdAt: watchedAt,
			updatedAt: watchedAt,
		});
	}

	if (show.rating !== undefined) {
		await insertUserRatings(client, {
			id: crypto.randomUUID(),
			profileId: PROFILE_ID,
			metadataId: show.titleId,
			rating: show.rating,
			createdAt: watchedAt,
			updatedAt: watchedAt,
		});
	}
}

async function seedWatching(client: TestClient, nowMs: number): Promise<void> {
	const libraryId = await seedProfileRows(client);
	for (const show of WATCHED) {
		const fileIds = await seedEpisodeFiles(client, show, libraryId);
		await seedWatchRows(client, show, fileIds, nowMs);
	}
}

const DR_HOUSE = "01a01607-59cd-74e4-86ca-45bce8767088";
const REZYDENCI = "01a01671-d2e0-7048-a8f8-e75b8cc07d7b";
const GOOD_DOCTOR = "01a01666-6518-72fe-b39b-9bc8be846925";
const OFF_CAMPUS = "01a1dc3d-5b17-758a-9c67-3fd00f31cc54";
const REJECT_IDS = new Set([
	"01a01628-320f-74ae-9cc0-a497278db024", // Sherlock
	"01a0162a-f80a-7014-8519-68d94cfa1d2f", // American Horror Story
	"01a026da-6565-72f3-8f8a-cdd12c780e62", // Latarnie
	"01a01131-db7f-7730-81a6-c0aa9b03dc5a", // Wyspa tajemnic (Shutter Island)
	"01a01144-cd16-70cf-9f44-aee6900db715", // Zaginiona dziewczyna (Gone Girl)
	"01a011b3-5add-7028-be20-1597c8fa772a", // Szósty zmysł (The Sixth Sense)
	"01a014dd-6df5-703e-b122-e25c8d4c07dc", // Spider-Noir
]);

beforeEach(() => {
	clearRecommendationFeatureStats();
});

describe("content-based recommendations for the reported binge profile", () => {
	test("ranks medical and romance shows above dark adult thrillers", async () => {
		const nowMs = Date.now();
		await seedCatalog(db.client(), nowMs);
		await seedWatching(db.client(), nowMs);

		const result = buildRecommendations(PROFILE_ID, 20);
		const servedIds = result.slate.map((entry) => entry.candidate.id);
		const topTen = servedIds.slice(0, 10);

		expect(topTen).toEqual(expect.arrayContaining([DR_HOUSE, REZYDENCI, GOOD_DOCTOR, OFF_CAMPUS]));
		expect(servedIds.filter((id) => REJECT_IDS.has(id))).toEqual([]);

		const tvCount = result.slate.filter((entry) => entry.candidate.type === "tv_show").length;
		expect(servedIds.length >= 5).toBe(true);
		expect(tvCount).toBe(servedIds.length);
		// Only the medical and romance shows earn a place; the slate's fifth title is the minimum backfill.
		// The seed shows carry no teenager/high school/coming of age keywords, so a teen title can only
		// link to them through broad mood tags ("thoughtful", "dramatic"), which never qualify on their own.
		expect(result.qualified.map((entry) => entry.candidate.id).toSorted()).toEqual(
			[DR_HOUSE, GOOD_DOCTOR, OFF_CAMPUS, REZYDENCI].toSorted(),
		);
		expect(result.slateByType.tv_show.map((entry) => entry.candidate.id)).toEqual(expect.arrayContaining([DR_HOUSE, REZYDENCI]));
		expect(result.slateByType.tv_show.every((entry) => entry.candidate.type === "tv_show")).toBe(true);
		// A shows-only profile gets no padded movie row; any movie there earned its place.
		expect(result.slateByType.movie.every((entry) => entry.qualifies)).toBe(true);
	});
});
