<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import type { Manga } from "$lib/types";
  import { addManga, checkUpdates, listManga } from "$lib/ipc";
  import MangaCard from "$lib/MangaCard.svelte";

  let library: Manga[] = $state([]);
  let newUrl = $state("");
  let adding = $state(false);
  let checking = $state(false);
  let error: string | null = $state(null);
  let loaded = $state(false);
  let unlisten: UnlistenFn | null = null;

  async function refresh() {
    library = await listManga();
    loaded = true;
  }

  onMount(async () => {
    // Crash-recovery handshake: the Rust side touched a marker at
    // startup; reaching this point proves the WebView renders, so
    // clear it. If we never get here, the next launch auto-falls-back
    // to safe rendering. See src-tauri/src/render_env.rs.
    void invoke("mark_app_ready").catch(() => {});
    await refresh();
    // The Rust side emits this whenever reader navigation records
    // progress or the background checker finds a new chapter.
    unlisten = await listen("library-updated", () => void refresh());
  });

  onDestroy(() => {
    unlisten?.();
  });

  async function add(event: SubmitEvent) {
    event.preventDefault();
    if (!newUrl.trim() || adding) {
      return;
    }
    adding = true;
    error = null;
    try {
      await addManga(newUrl);
      newUrl = "";
      await refresh();
    } catch (e) {
      error = String(e);
    } finally {
      adding = false;
    }
  }

  async function checkNow() {
    checking = true;
    error = null;
    try {
      library = await checkUpdates();
    } catch (e) {
      error = String(e);
    } finally {
      checking = false;
    }
  }
</script>

<main>
  <header>
    <h1>FRANK <span>Scanlation</span></h1>
    <button onclick={checkNow} disabled={checking}>
      {checking ? "Checking…" : "Check for new chapters"}
    </button>
  </header>

  <form class="add" onsubmit={add}>
    <input
      type="url"
      placeholder="Paste a scanlation site URL, e.g. https://zom-100-bucket-list-of-the-dead.online/"
      bind:value={newUrl}
      disabled={adding}
    />
    <button class="primary" type="submit" disabled={adding || !newUrl.trim()}>
      {adding ? "Adding…" : "Add manga"}
    </button>
  </form>

  {#if error}
    <p class="error">{error}</p>
  {/if}

  {#if loaded && library.length === 0}
    <div class="empty">
      <p>Your library is empty.</p>
      <p class="hint">
        Paste the URL of a scanlation site above. The app figures out the
        title, cover and chapter list on its own — no site-specific setup.
      </p>
    </div>
  {:else}
    <section class="grid">
      {#each library as manga (manga.id)}
        <MangaCard {manga} onchanged={refresh} />
      {/each}
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px 24px 48px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 18px;
  }

  h1 {
    margin: 0;
    font-size: 1.4rem;
    letter-spacing: 0.02em;
  }

  h1 span {
    color: var(--accent);
  }

  .add {
    display: flex;
    gap: 10px;
    margin-bottom: 14px;
  }

  .add input {
    flex: 1;
  }

  .add button {
    white-space: nowrap;
  }

  .error {
    background: rgba(208, 85, 85, 0.12);
    border: 1px solid var(--danger);
    border-radius: 8px;
    padding: 10px 14px;
    color: #f0b3b3;
  }

  .empty {
    text-align: center;
    padding: 80px 20px;
    color: var(--text-dim);
  }

  .empty .hint {
    max-width: 460px;
    margin: 8px auto 0;
    font-size: 0.9rem;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 16px;
  }
</style>
