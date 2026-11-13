/**
 * Raises a problem that needs a person. The repo has no error reporting yet,
 * so this only logs, with a prefix to search or alert on in Netlify's logs.
 */
export function alert(message: string): void {
  console.error(`[paying-sync ALERT] ${message}`);
}
