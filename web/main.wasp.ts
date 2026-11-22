import { app, page, route } from "@wasp.sh/spec";
import {
  StoryPage,
  StagePage,
  CinemaPage,
  FilmPage,
} from "./src/Pages" with { type: "ref" };

export default app({
  name: "telepathyStudio",
  wasp: { version: "^0.26.1" },
  title: "Telepathy",
  head: [
    "<meta name='theme-color' content='#111316' />",
    "<link rel='icon' href='/mark.svg' />",
  ],
  spec: [
    route("Story", "/", page(StoryPage)),
    route("Cinema", "/cinema", page(CinemaPage)),
    route("Film", "/film", page(FilmPage)),
    route("Stage", "/stage", page(StagePage)),
  ],
});
