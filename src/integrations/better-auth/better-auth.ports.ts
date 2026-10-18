import { DomainError } from "@/utils/domain.errors";

/** Runs after Better Auth creates a user. The app registers the implementation at startup. */
export interface AuthUserCreatedPort {
	onUserCreated(user: { id: string; name: string }): Promise<void>;
}

let userCreatedPort: AuthUserCreatedPort | undefined;

export function wireAuthUserCreated(port: AuthUserCreatedPort): void {
	userCreatedPort = port;
}

export function authUserCreated(): AuthUserCreatedPort {
	if (!userCreatedPort) {
		throw new DomainError("internal", "Auth user-created port is not wired", { code: "auth.user_created_port_not_wired" });
	}

	return userCreatedPort;
}
