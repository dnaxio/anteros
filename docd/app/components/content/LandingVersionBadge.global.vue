<template>
  <div class="mb-8 flex justify-center">
    <NuxtLink :to="href">
      <UiBadgeGroup size="lg" :addon-text="label" theme="modern" pulse>
        Now available
      </UiBadgeGroup>
    </NuxtLink>
  </div>
</template>

<script setup lang="ts">
  const version = String(useRuntimeConfig().public.coreVersion ?? "").trim();
  const label = version ? `v${version}` : "latest";
  const href = "/docs/getting-started/quick-start";
</script>
