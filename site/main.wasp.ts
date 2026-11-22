import { app, page, route } from "@wasp.sh/spec";
import { StoryPage } from "./src/story/StoryPage" with { type: "ref" };
import { FilmPage } from "./src/film/FilmPage" with { type: "ref" };
import { StagePage } from "./src/stage/StagePage" with { type: "ref" };

export default app({
  name: "site",
  wasp: { version: "^0.26.1" },
  title: "Telepathy",
  head: ["<link rel='icon' href='/favicon.ico' />", "<meta name='theme-color' content='#000000' />"],
  spec: [
    route("StoryRoute", "/", page(StoryPage)),
    route("FilmRoute", "/film", page(FilmPage)),
    route("StageRoute", "/stage", page(StagePage)),
  ],
});
