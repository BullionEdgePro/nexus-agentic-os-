import { redirect } from "next/navigation";

/**
 * `/login` used to be the front page — the marketing plate and the sign-in form
 * lived here, and `/` redirected to it, so the public URL people were given was
 * nexusagenticos.com/login rather than the bare domain.
 *
 * The page now lives at `/`. This route is kept as a permanent redirect rather
 * than deleted because the old URL is already in browser histories and
 * bookmarks, and a 404 on the sign-in page is an unnecessary way to lose an
 * operator. The sign-in form is the `#signin` section of the front page.
 */
export default function LoginRedirect() {
  redirect("/#signin");
}
