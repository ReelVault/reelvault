import { trimAndFilter } from "@/utils/array.utils";
import { isFiniteNumber } from "@/utils/type.utils";

export interface ValueCodec<T> {
	parse(raw: string): T | null;
	serialize(value: T): string;
}

export function createValueCodecs() {
	return {
		string: (): ValueCodec<string> => ({
			parse: (raw) => raw.trim() || null,
			serialize: (value) => value,
		}),
		nullableString: (): ValueCodec<string | null> => ({
			parse: (raw) => raw.trim() || null,
			serialize: (value) => value ?? "",
		}),
		number: (min: number, max: number): ValueCodec<number> => ({
			parse: (raw) => {
				const trimmed = raw.trim();
				if (trimmed === "") return null;

				const num = Number(trimmed);

				return isFiniteNumber(num) && num >= min && num <= max ? num : null;
			},
			serialize: (value) => String(value),
		}),
		boolean: (): ValueCodec<boolean> => ({
			parse: (raw) => {
				if (raw === "true" || raw === "1") return true;

				if (raw === "false" || raw === "0") return false;

				return null;
			},
			serialize: (value) => String(value),
		}),
		stringArray: (): ValueCodec<string[]> => ({
			parse: (raw) => {
				if (!raw) return null;

				try {
					const parsed: unknown = JSON.parse(raw);
					if (Array.isArray(parsed)) {
						return trimAndFilter(parsed.filter((item): item is string => typeof item === "string"));
					}
				} catch {
					// Fallback for comma-separated raw strings
				}

				return trimAndFilter(raw.split(","));
			},
			serialize: (value) => JSON.stringify(Array.isArray(value) ? value : []),
		}),
		enum: <T extends string>(options: readonly T[]): ValueCodec<T> => ({
			parse: (raw) => options.find((option) => option === raw) ?? null,
			serialize: (value) => value,
		}),
	};
}
