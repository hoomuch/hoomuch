/**
 * A page response's HTML without React's text separators. renderToString puts `<!-- -->`
 * between adjacent text nodes ("Syncing now<!-- -->, usually…") so hydration can split them
 * again; browsers ignore the comments, and so do these assertions.
 */
export async function htmlOf(res: Response): Promise<string> {
  return (await res.text()).replace(/<!-- -->/g, '');
}
