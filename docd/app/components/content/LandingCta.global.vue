<template>
  <section class="border-t">
    <UiContainer class="py-16 sm:py-20">
      <div class="mx-auto max-w-2xl text-center">
        <h2 v-if="title" class="text-2xl font-bold tracking-tight text-balance sm:text-3xl">
          {{ title }}
        </h2>
        <p v-if="description" class="mt-3 text-balance text-muted-foreground">
          {{ description }}
        </p>
        <div
          v-if="primary || secondary"
          class="mt-10 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-center"
        >
          <UiButton
            v-if="primary"
            size="lg"
            :to="primary.href"
            class="order-1 w-full sm:order-2 sm:w-auto"
          >
            <Icon v-if="primary.icon" :name="primary.icon" class="size-4" />
            {{ primary.label }}
          </UiButton>
          <UiButton
            v-if="secondary"
            variant="secondary"
            size="lg"
            :to="secondary.href"
            class="order-2 w-full sm:order-1 sm:w-auto"
          >
            <Icon v-if="secondary.icon" :name="secondary.icon" class="size-4" />
            {{ secondary.label }}
          </UiButton>
        </div>
      </div>
    </UiContainer>
  </section>
</template>

<script lang="ts" setup>
  /**
   * Closing call-to-action section for landing pages.
   *
   * ```md
   * ::landing-cta
   * ---
   * title: Ready to build?
   * description: Create your first Anteros project in seconds.
   * primary:
   *   label: Quick Start
   *   href: /docs/getting-started/quick-start
   * secondary:
   *   label: Explore the docs
   *   href: /docs/reference/configuration
   * ---
   * ::
   * ```
   */
  interface LandingCtaLink {
    label: string;
    href?: string;
    icon?: string;
  }

  defineProps<{
    /** Optional section heading. */
    title?: string;
    /** Optional section description rendered under the heading. */
    description?: string;
    /** Primary (filled) call to action. */
    primary?: LandingCtaLink;
    /** Secondary (outlined) call to action. */
    secondary?: LandingCtaLink;
  }>();
</script>
