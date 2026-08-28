/* ============================================================================
   ngbus-bus.js — tidy up after the bus's entry animation.

   That is the whole job. The animation is declared in `ngbus.css` and starts by
   itself on the first painted frame; nothing here arms it, and a browser that
   never loads this file sees the entry run and end correctly. This only strips
   the class afterwards, so no element is left carrying an animation that has
   already finished.

   WHY THE ANIMATION IS NOT STARTED HERE
   -------------------------------------
   It used to be. This file added an `is-running` class once the bus scrolled
   into view, which read well in principle — the run began when someone could
   actually see it, and not during the league table's first render.

   In practice it produced a visible fault. CSS painted the bus at rest, the
   class arrived a frame or two later, `backwards` fill snapped it off-stage,
   and it drove in again: the bus appeared, vanished, and re-entered. Any
   arrangement where the resting state is painted first and the animation is
   armed second has that flash built into it, and no amount of requestAnimationFrame
   juggling removes it — the two states are simply painted in the wrong order.

   Declaring the animation in CSS means the first painted frame is already the
   first frame of the run. Both buses sit at the top of their pages, so nothing
   was really gained by waiting for them to be scrolled to.

   WHY IT STILL EXISTS
   -------------------
   A finished animation is not free of consequences: the element stays flagged
   as animated, which is what kept a compositor layer alive while the SVG filter
   raster went missing — the "wireframe bus" that was reported. Removing the
   class when the run ends puts the element back to plain, unanimated CSS.
   Cheap insurance against a bug that was hard to reproduce and easy to ship.

   OWNED BY THIS REPO — nothing outside the Hugo site writes this file.
   ========================================================================== */

(function () {
  'use strict';

  var SELECTOR = '.ngbus-bus--anim';

  /* Longest a run can legitimately take — duration plus delay, plus slack. If
     `animationend` has not fired by then, the animation either never started or
     something swallowed the event, and the class should come off regardless. */
  var MAX_RUN_MS = 3000;

  function settle(bus) {
    /* Back to plain CSS: the animation used `backwards` fill, so it holds
       nothing once it is over and this changes how the bus looks not at all. */
    bus.classList.remove('ngbus-bus--anim');
  }

  function watch(bus) {
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      bus.removeEventListener('animationend', onEnd);
      settle(bus);
    };
    var onEnd = function (e) {
      /* Only the bus's own slide ends the run. The red plate's fade finishes
         earlier and must not strip the class mid-slide. */
      if (e.target === bus && e.animationName === 'ngbus-pull-in') finish();
    };
    bus.addEventListener('animationend', onEnd);
    window.setTimeout(finish, MAX_RUN_MS);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll(SELECTOR), watch);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
