"""V5: object-based auto-digitizing engine.

Architecture (see RESEARCH.md):

    frontend (lineart / vector / raster)
        → StitchObjects (objects.py) with StitchProperties
        → sequencer + transit planner (compile.py)
        → per-object stitch generation (stitchgen/)
        → StitchPlan → pyembroidery encoder → DST/PES/EXP/JEF + preview

pyembroidery is used strictly as the format encoder; the model lives here.
"""
