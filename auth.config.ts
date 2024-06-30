import CredentialsProvider from '@auth/core/providers/credentials'
import Authentik from "@auth/core/providers/authentik"
import { defineConfig } from 'auth-astro'

export default defineConfig({
  providers: [
    CredentialsProvider({
      // The name to display on the sign in form (e.g. "Sign in with...")
      name: 'Credentials',
      // `credentials` is used to generate a form on the sign in page.
      // You can specify which fields should be submitted, by adding keys to the `credentials` object.
      // e.g. domain, username, password, 2FA token, etc.
      // You can pass any HTML attribute to the <input> tag through the object.
      credentials: {
        username: { label: 'Username', type: 'text', placeholder: 'codeseys' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        if (
          credentials.username === 'codeseys' &&
          credentials.password === 'generalpass'
        ) {
          return {
            id: '1',
            name: 'codeseys',
            email: 'anon@codeseys.io',
          }
        } else {
          return null
        }
      },
    }),
    Authentik({
      clientId: import.meta.env.AUTHENTIK_CLIENT_ID,
      clientSecret: import.meta.env.AUTHENTIK_CLIENT_SECRET,
      issuer: import.meta.env.AUTHENTIK_ISSUER,
    }),
  ],
})
