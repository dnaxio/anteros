<template>
  <Icon
    v-if="name === 'duckdb'"
    name="simple-icons:duckdb"
    class="size-6 text-muted-foreground"
  />
  <Terminal
    v-else-if="name === 'quack'"
    :size="24"
    class="text-muted-foreground"
  />
  <Typescript
    v-else
    :size="24"
    class="text-muted-foreground"
  />
</template>

<script lang="ts" setup>
  import { Terminal, Typescript } from "@dev.icons/vue/mono";

  defineProps<{
    /** First-party package whose icon to render. */
    name: "duckdb" | "quack" | "sdk";
  }>();
</script>
