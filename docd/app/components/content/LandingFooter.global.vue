<template>
    <footer class="border-t">
        <div
            class="mx-auto flex w-full max-w-7xl flex-row flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-4 py-10 text-sm text-muted-foreground sm:px-6 sm:py-12 2xl:max-w-(--breakpoint-2xl)"
        >
            <p>{{ copyright }}</p>
            <p>
                Powered by
                <NuxtLink
                    v-if="poweredHref"
                    :to="poweredHref"
                    target="_blank"
                    rel="noopener"
                    class="font-medium text-foreground transition-colors hover:text-primary"
                >
                    {{ poweredBy }}
                </NuxtLink>
                <span v-else class="font-medium text-foreground">{{
                    poweredBy
                }}</span>
            </p>
        </div>
    </footer>
</template>

<script lang="ts" setup>
/**
 * Footer for landing pages — copyright on the left, "Powered by" on the right.
 *
 * ```md
 * ::landing-footer
 * ::
 * ```
 *
 * The box mirrors the sections above (`max-w-7xl` + `px-4 sm:px-6`, same
 * `2xl` breakpoint as `UiContainer`) so the two columns line up with the cards,
 * and the row keeps its left/right layout at every width — it only wraps when
 * there is really no room. Every value can be overridden by a prop; the credit
 * becomes a link when `poweredHref` is set.
 */
withDefaults(
    defineProps<{
        /** Left side. */
        copyright?: string;
        /** Right side — the company behind the project. */
        poweredBy?: string;
        /** Optional link for the `poweredBy` name. */
        poweredHref?: string;
    }>(),
    {
        copyright: `© ${new Date().getFullYear()} Anteros. All rights reserved.`,
        poweredBy: "Dnax Inc",
        poweredHref: "",
    },
);
</script>
