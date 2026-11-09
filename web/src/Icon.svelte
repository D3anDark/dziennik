<script>
  /** Outline icons on a 24px grid, drawn with currentColor. Decorative: the text next to them carries the meaning. */
  let { name, size = 22 } = $props();

  const PATHS = {
    home: ['M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z'],
    star: ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z'],
    clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5V12l3 2'],
    check: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8 12.5l2.7 2.7L16 9.8'],
    grid: ['M5 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M15 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', 'M5 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z', 'M15 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z'],
    calendar: ['M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
    book: ['M6 3.5h12a1 1 0 0 1 1 1V17H7a2 2 0 0 0-2 2V4.5a1 1 0 0 1 1-1z', 'M5 19a2 2 0 0 0 2 2h12v-4', 'M9 8h6'],
    mail: ['M5 5.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M3.5 7l8.5 6 8.5-6'],
    megaphone: ['M4 9.5v5h3l7 4.5v-14L7 9.5z', 'M17.5 9a4 4 0 0 1 0 6'],
    note: ['M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M9.5 13h5', 'M9.5 17h3'],
    smile: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M8.5 14.5a4.5 4.5 0 0 0 7 0', 'M9 9.5v.5', 'M15 9.5v.5'],
    users: ['M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M3 20a6 6 0 0 1 12 0', 'M15.5 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.2a6 6 0 0 1 3 5.8'],
    logout: ['M9.5 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3.5', 'M15.5 8l4 4-4 4', 'M19.5 12H9.5'],
    left: ['M14.5 6l-6 6 6 6'],
    right: ['M9.5 6l6 6-6 6'],
    down: ['M6 9.5l6 6 6-6'],
    pencil: ['M4.5 19.5h4l10-10a2.8 2.8 0 0 0-4-4l-10 10z', 'M13.5 6.5l4 4'],
    reply: ['M9.5 6.5 4.5 11.5l5 5', 'M4.5 11.5H14a5.5 5.5 0 0 1 5.5 5.5v1.5'],
    done: ['M5 12.5l4.5 4.5L19 7.5'],
    close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
    paperclip: ['M19 11.5l-7.2 7.2a4.6 4.6 0 0 1-6.5-6.5l7.4-7.4a3 3 0 0 1 4.3 4.3l-7.2 7.2a1.5 1.5 0 0 1-2.1-2.1l6.6-6.6'],
  };
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#each PATHS[name] ?? [] as d (d)}<path {d} />{/each}
</svg>
