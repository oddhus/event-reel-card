// hls.js ships no types for its "light" export; it has the same API as the full build.
declare module "hls.js/light" {
  import Hls from "hls.js";
  export default Hls;
}
