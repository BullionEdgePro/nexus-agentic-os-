import TeamWorkspace from "./team-workspace";

/**
 * The operator's view of a team: pick a business, pick a person, manage the
 * roster, issue sign-in codes.
 *
 * An employee signing in gets the same component from `/` with `lockedTo` set,
 * which scopes it to them and hides the roster management. This route stays
 * unlocked because the middleware only lets a session through, and the API is
 * what actually enforces scope — an employee who navigates here directly sees
 * their own business and nothing else, because every call is filtered server
 * side.
 */
export default function TeamPage() {
  return <TeamWorkspace />;
}
