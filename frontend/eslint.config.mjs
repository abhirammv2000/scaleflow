import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // The LLM/vector-DB glue code (agents, services, Pinecone/Supabase
      // wrappers) passes around dynamically-shaped JSON from OpenAI,
      // Pinecone and Supabase. Properly typing all of it is worthwhile
      // follow-up work, but isn't a build-blocking lint error for now.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];

export default eslintConfig;
