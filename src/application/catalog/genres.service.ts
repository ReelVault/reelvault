import type { CreateGenre, Genre, GenreFilters, GenreSorting, UpdateGenre } from "@reelvault/sdk/common";
import { genreRepository } from "@/database/repositories/genres.repository";
import { DictionaryCrudService } from "./dictionary-crud.service";

class GenresService extends DictionaryCrudService<Genre, CreateGenre, UpdateGenre, GenreFilters, GenreSorting, typeof genreRepository> {
	constructor() {
		super("GenresService", "Genre", genreRepository);
	}
}

export const genresService = new GenresService();
