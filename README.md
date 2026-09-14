# Homework tracker — backend setup

The app (`index.html`) now signs people in and saves each person's homework to your
Supabase project. Everything is already wired up in the code — you just need to do
**two quick things in the Supabase dashboard** the first time.

---

## 1. Create the database table  *(required)*

This makes the `tasks` and `profiles` tables (the latter stores each person's chosen
subjects) and turns on row-level security so each user can only ever see their own data.

1. Open your project → **SQL Editor** → **New query**.
2. Paste in the whole of [`supabase/migrations/20260707000000_init.sql`](supabase/migrations/20260707000000_init.sql).
3. Click **Run**. You should see "Success. No rows returned."

The whole file is safe to re-run, so if you set the tables up earlier, just run it again —
it only adds what's missing (e.g. the newer `profiles.prefs` column that stores each
person's tab / "hide empty" preference so it follows their account across devices).

That's it — the backend is live.

## 2. Make sign-up instant  *(recommended, for the fastest experience)*

By default Supabase emails a confirmation link before a new account can be used. To
let people sign up and start using the tracker immediately:

- Go to **Authentication → Sign In / Providers → Email**.
- Turn **"Confirm email"** *off* and save.

The app works either way:
- **Off** → sign up, and you're straight in.
- **On** → after sign-up the app says "check your email to confirm", then they sign in.

## 3. Make "Forgot password" links work  *(only if you host the app)*

The **Forgot your password?** link emails a reset link that must return to the app. For
that link to be allowed, add the app's address under **Authentication → URL Configuration**:

- Set the **Site URL** to where you host `index.html`.
- Add that same URL to **Redirect URLs**.

Reset emails use Supabase's built-in mailer, which is rate-limited and fine for personal
use; for higher volume, configure your own SMTP under **Authentication → Emails**.

---

## Using it

- Open `index.html`. First-time users click **Create an account** (email + password,
  6+ characters); returning users just **Sign in**.
- On first sign-in they pick their **subjects** from the list. This is saved to their
  account and can be changed any time via the **⚙ Settings** button.
- Settings also has an **Appearance** control: System / Light / Dark (saved on the device,
  applied instantly with no flash).
- Sessions are remembered on the device, so people stay signed in across reloads and
  browser restarts until they hit **Sign out**.
- Tasks and chosen subjects are saved per user in Supabase, so the same account shows the
  same homework on any device.

## Notes

- The publishable key in `index.html` is meant to be public — your data is safe because
  row-level security (step 1) means the key alone can't read anyone's rows without a
  signed-in token.
- View or manage accounts under **Authentication → Users**, and the saved homework under
  **Table Editor → tasks**.

### Optional: apply the schema with the CLI instead of the dashboard

```bash
supabase login
supabase link --project-ref yfzlypcxsmlakpxkrtbu
supabase db push        # applies supabase/migrations/*.sql
```
