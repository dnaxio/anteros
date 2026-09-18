<template>
  <section class="border-t">
    <UiContainer class="py-16 sm:py-20">
      <div v-if="title || description" class="mx-auto mb-12 max-w-2xl text-center">
        <h2 v-if="title" class="text-2xl font-bold tracking-tight text-balance sm:text-3xl">
          {{ title }}
        </h2>
        <p v-if="description" class="mt-3 text-balance text-muted-foreground">
          {{ description }}
        </p>
      </div>
      <div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <slot />
      </div>
    </UiContainer>
  </section>
</template>

<script lang="ts" setup>
  /**
   * Responsive grid wrapper for `::prose-card` blocks on landing pages.
   *
   * ```md
   * ::landing-features{title="Everything you need."}
   *   ::prose-card{icon="lucide:zap" title="Fast"}
   *   Ship in minutes.
   *   ::
   * ::
   * ```
   */
  defineProps<{
    /** Optional section heading. */
    title?: string;
    /** Optional section description rendered under the heading. */
    description?: string;
  }>();
</script>
