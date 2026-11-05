# SDK capabilities

Generation baseline commit: `11d914eddf3c0c6db8ce64fd48dd39638addc02e`

| Name | Form |
| --- | --- |
| Renderer extract/prepare/record | built-in |
| `createRenderer` assembly | built-in |
| Standard render pipeline | built-in |
| Standard Deferred lighting | opt-in |
| URP/HDRP parity asset configuration | test-experimental |
| Typed RenderGraph | built-in |
| RenderGraph dependencies and barriers | built-in |
| RenderGraph last-known-good | built-in |
| RenderFeature injection | opt-in |
| RenderFeature submission receipt | development |
| Frame-varying occlusion query sets | built-in |
| Custom RenderPipeline | opt-in |
| Custom fullscreen post-processing | opt-in |
| Unified color-domain contract | built-in |
| Persistent Render Scene | built-in |
| Multi-World composition | built-in |
| Multi-camera CameraView composition | built-in |
| Non-XR stereo output | opt-in |
| Reverse-Z depth | built-in |
| Render bundle reuse | built-in |
| Frame observation | development |
| Semantic scene-data target | built-in |
| Renderer health and recovery | built-in |
| Perspective camera | built-in |
| Orthographic camera | built-in |
| Offscreen RenderTarget | opt-in |
| CubeCamera capture | opt-in |
| ReflectionProbe IBL | opt-in |
| Planar reflection capture | opt-in |
| Public clipping planes | opt-in |
| Selection outline | opt-in |
| Hierarchical visibility | built-in |
| Frustum culling | built-in |
| Adjacent LOD coverage blending | built-in |
| Layer and sort keys | built-in |
| Transparent material sorting | built-in |
| GPU Instancing | built-in |
| Multiple submeshes/materials | built-in |
| Mixed primitive topology | built-in |
| Shadow participation | built-in |
| Standard PBR | built-in |
| Unlit shading | built-in |
| Directional Light | built-in |
| Point Light | built-in |
| Spot Light | built-in |
| IES light profiles | opt-in |
| Multiple-light PBR | built-in |
| Standard clustered lighting | opt-in |
| Directional CSM/PCSS | built-in |
| Directional contact shadows | opt-in |
| Point cube shadow | opt-in |
| Spot shadow atlas | opt-in |
| Shadow caster opt-out | built-in |
| Incremental shadow cache | built-in |
| Capsule shadows | opt-in |
| Baked lighting identity | built-in |
| Custom ShadowCaster pass | opt-in |
| Skylight IBL | opt-in |
| Cubemap Skybox | opt-in |
| Analytic Sky | opt-in |
| Environment generation/LKG | built-in |
| Scene Fog | opt-in |
| Volumetric Fog | opt-in |
| Fog inspection/LKG | built-in |
| HDR scene color | opt-in |
| Tone Mapping | opt-in |
| Bloom | opt-in |
| Screen-space ambient occlusion | opt-in |
| Screen-space reflections | opt-in |
| FXAA | opt-in |
| SMAA 1x | opt-in |
| Lens effects | opt-in |
| BarrelDistortion | opt-in |
| MSAA | opt-in |
| TAA | opt-in |
| TAAU dynamic resolution | opt-in |
| Camera Depth of Field | opt-in |
| TAA history reset | built-in |
| TAAU GPU-driven coverage | built-in |
| TAA inspection/recovery | built-in |
| Motion Blur | opt-in |
| HDRP SSAO | test-experimental |
| Auto exposure | opt-in |
| 3D LUT color grading | opt-in |
| Single MaterialAsset path | built-in |
| Pass-based MaterialAsset | built-in |
| Material inheritance | built-in |
| Material texture transform | built-in |
| Material render state | built-in |
| Material color writes and polygon depth offset | built-in |
| Public material MRT | opt-in |
| Independent Standard scalar maps | opt-in |
| Standard normal and bump mapping | opt-in |
| Alpha Hash coverage | opt-in |
| Material `paramSchema` derivation | built-in |
| Material reflection gate | build-time |
| Runtime Shader Registry | built-in |
| Built-in WGSL modules | built-in |
| WGSL `#import` composition | build-time |
| Shader variants | build-time |
| Naga validation/reflection | build-time |
| Vite Shader plugin | build-time |
| Custom Material Shader | opt-in |
| Transmission/refraction material | opt-in |
| Runtime CanvasTexture | opt-in |
| Standard height vertex displacement | opt-in |
| Mesh decals | opt-in |
| Projected decals | opt-in |
| 3D Procedural Geometry | built-in |
| 2D Procedural Geometry | built-in |
| Edge conversion factories | built-in |
| Tangent generation | built-in |
| Canonical vertex layout | built-in |
| GPU normal matrix and compact mesh payloads | built-in |
| Binary morph targets (mesh-bin v5) | built-in |
| Points/Lines rendering | opt-in |
| Mesh vertex color | built-in |
| Multiple UV sets | built-in |
| Scene hierarchy | built-in |
| Three.js compatibility | test-experimental |
| Mobility | built-in |
| O(D) moving-object propagation | built-in |
| SceneAsset instantiation | built-in |
| Nested Scene mounts | built-in |
| Renderer-independent Skin | built-in |
| GPU skin palette | built-in |
| AnimationClip playback | built-in |
| Stable animation target id | built-in |
| Spring bone secondary motion | opt-in |
| Managed physical skeleton blend | opt-in |
| Object property animation | opt-in |
| Inverse kinematics | opt-in |
| Spline IK | opt-in |
| Skeleton retargeting | opt-in |
| Animation timeline and root motion | opt-in |
| AnimationGraph | built-in |
| Code-driven animation blending | opt-in |
| Morph/BlendShape GPU deformation | opt-in |
| Sprite | built-in |
| Sprite Atlas | built-in |
| Sprite Instances | built-in |
| Sprite Lit | built-in |
| Continuous and dashed line paths | built-in |
| Tilemap | built-in |
| Tile flip/rotation bits | built-in |
| Tilemap object semantics | built-in |
| World-space MSDF Text | built-in |
| Video Texture | opt-in |
| Prepared UiAsset | host-side |
| UI authoring validation | build-time |
| UI preview evidence | development |
| Spec-aligned RHI | built-in |
| Opaque GPU handles | built-in |
| RHI capability model | built-in |
| Browser WebGPU backend | built-in |
| WebGPU CPU diagnostics | development |
| wgpu WASM backend | built-in |
| WebGL2 downlevel lane | opt-in |
| RhiNull | test-experimental |
| Native wgpu/Ray Query spike | test-experimental |
| Native wgpu source pin | build-time |
| Compute pass | built-in |
| Indirect drawing | opt-in |
| Timestamp query | opt-in |
| GPU Scene tables | built-in |
| GPU view culling | built-in |
| GPU draw compaction | built-in |
| GPU-driven custom Surface ABI | opt-in |
| CPU capability fallback | built-in |
| Deferred membership timing | development |
| Code-first VFX source | opt-in |
| VFX compiler/cooker | build-time |
| VFX ECS player | opt-in |
| Persistent GPU simulation | opt-in |
| Managed scene SDF collision | development |
| VFX indirect rendering | opt-in |
| VFX submission observation | development |
| Billboard particles | opt-in |
| Mesh particles | opt-in |
| Ribbon particles | opt-in |
| Trail particles | opt-in |
| Beam particles | opt-in |
| VFX fixed-bounds culling | opt-in |
| VFX capability refusal | built-in |
| VFX inspection/LKG | development |
| POD/Result SSOT | built-in |
| Typed Handle | built-in |
| Format-independent asset POD | built-in |
| Out-param math | built-in |
| WebGPU/WebGL/Reverse-Z projections | built-in |
| 3D geometry queries | built-in |
| 2D geometry queries | built-in |
| Color conversion | built-in |
| World state authority | built-in |
| Schema-defined component | built-in |
| Archetype SoA storage | built-in |
| Sparse tag component | built-in |
| Query row | built-in |
| QuerySpan | built-in |
| Update schedule | built-in |
| FixedUpdate schedule | built-in |
| Deferred commands | built-in |
| ECS Resource | built-in |
| Relationship reverse index | built-in |
| Bounded change projection | built-in |
| Externalization/remap | built-in |
| Shared numeric kernels | opt-in |
| World inspection | development |
| World-local ComponentCatalog lease | built-in |
| UniqueRef/SharedRef write barrier | built-in |
| World poison | built-in |
| Saved paths and world-distance following | opt-in |
| Graph/grid navigation and path following | opt-in |
| Static NavMesh and physical character navigation | opt-in |
| Typed StateToken | built-in |
| Deferred state transition | built-in |
| State-scoped entities | built-in |
| OnEnter/OnExit hooks | built-in |
| `inState` condition | built-in |
| App Host adapter | built-in |
| Canvas assembly | built-in |
| Injected assembly | built-in |
| Start/stop/pause/resume | built-in |
| Main-serial tier | built-in |
| Engine-worker tier | opt-in |
| Shared tier | opt-in |
| Auto tier selection | built-in |
| One-credit Worker frame pacing | opt-in |
| Execution report | built-in |
| Load progress and timeline | built-in |
| Explicit Worker World rebuild | opt-in |
| Surface handoff | built-in |
| Draw source routing | built-in |
| Renderer feature passthrough | built-in |
| Optional CPU profiler passthrough | opt-in |
| Tool Preview Host | development |
| Frozen InputSnapshot | built-in |
| Keyboard input | host-side |
| Mouse input | host-side |
| Gamepad input | host-side |
| Gamepad feedback | host-side |
| Multi-pointer input | host-side |
| Pointer Lock | host-side |
| Action mapping | built-in |
| Virtual axis/joystick | built-in |
| Gesture recognition | built-in |
| Input capability probe | built-in |
| Cordis Context/Fiber | built-in |
| Static plugin programs | build-time |
| Plugin realm placement | built-in |
| `forge.json` manifest | built-in |
| Realm bootstrap | built-in |
| DSH federation bridge | opt-in |
| DSH Engine panel | opt-in |
| Physics ECS interface | built-in |
| 2D Rapier backend | opt-in |
| 3D Rapier backend | opt-in |
| Three-phase physics tick | built-in |
| Rigid body types | built-in |
| Collider shapes | built-in |
| Voxel collision and editing | opt-in |
| Current contact queries | opt-in |
| Collision pairs/events | built-in |
| Physics raycast | built-in |
| Teleport | built-in |
| `moveAndSlide` KCC | built-in |
| Physics readiness | built-in |
| Realm-neutral AudioSource | built-in |
| AudioListener | built-in |
| Host Web Audio backend | host-side |
| Audio decode cache | host-side |
| Clip start and seek | built-in |
| Configurable audio buses | host-side |
| Long audio windows | host-side |
| 3D spatial audio | host-side |
| Acoustic regions | opt-in |
| Audio entity epoch fencing | host-side |
| Quantized layered music | host-side |
| Audio cleanup | host-side |
| Host-neutral NetEndpoint | built-in |
| NetSession | built-in |
| Replication profile | opt-in |
| Authority replication | opt-in |
| Per-session replication visibility | opt-in |
| Replica atomic validation | opt-in |
| Browser WebSocket client | opt-in |
| Node WebSocket client/listener | opt-in |
| Memory fault transport | test-experimental |
| Provider-neutral Activity | built-in |
| Intelligence MessagePort bridge | opt-in |
| Deterministic fake provider | test-experimental |
| DSH Activity provider | host-side |
| NpcBrain ECS binding | built-in |
| Host-injected NPC adapter | opt-in |
| External Meta sidecar | build-time |
| Pack source / transport | build-time |
| AssetGuid | built-in |
| SourceKey identity reuse | build-time |
| Pack scanner | build-time |
| ScriptablePack / Pack | build-time |
| ScriptablePack executor | build-time |
| Asset output producers | build-time |
| Native cooker registry | build-time |
| Producer facts/receipts | build-time |
| AssetEnvelope refs | built-in |
| Asset kind/runtime decoder matrix | built-in |
| AssetEvidence | development |
| Asset authority audit | development |
| Pack index | build-time |
| Catalog authority | build-time |
| Catalog delta | development |
| Hot content-catalog refresh | development |
| CatalogSource lifecycle | built-in |
| Catalog replica admission | built-in |
| Runtime Pack generation | opt-in |
| Cook source snapshot | build-time |
| Runtime binding SSOT | development |
| ImporterRegistry | build-time |
| Meta-driven import | build-time |
| Lazy import transport | development |
| Import cycle/timeout detection | build-time |
| Vite Pack plugin | build-time |
| Development Pack routes | development |
| DDC v2 | build-time |
| DDC lifecycle/CAS | build-time |
| AssetRegistry | built-in |
| Runtime asset editing | built-in |
| `AssetRegistry.load` | built-in |
| Asset decoder ownership | built-in |
| Recursive ref loading | built-in |
| Primitive mesh factories | built-in |
| Engine Content library | opt-in |
| World asset references | built-in |
| Scene instantiate transaction | built-in |
| Runtime publication preparation | built-in |
| Transient package read retry | built-in |
| DynamicTextureStore | built-in |
| Runtime PNG/JPEG decode | built-in |
| Image importer | build-time |
| 2D-array/3D TextureAsset | built-in |
| Texture compression policy | build-time |
| Offline mip chain | build-time |
| HDR RGBE import | build-time |
| Zstd runtime decode | built-in |
| KTX2/Basis transcode | built-in |
| Build-time Zstd encode | build-time |
| glTF/GLB parse | build-time |
| glTF importer | build-time |
| glTF scene load | built-in |
| glTF skin/animation | opt-in |
| FBX WASM parser | build-time |
| FBX importer | build-time |
| FBX material mapping | build-time |
| Font MSDF bake | build-time |
| Lightmap UV validation | build-time |
| Font runtime load | built-in |
| Audio asset load | built-in |
| Particle-effect asset | built-in |
| `forgeax` CLI front door | development |
| Project lifecycle commands | development |
| Unified live game iteration | development |
| Bounded asset discovery and verification | development |
| Browser compositor capture | development |
| Borrowed browser Page capture | development |
| Persistent playthrough capture | development |
| Scripted gameplay verification | development |
| Single-HTML offline delivery | development |
| Player Asset Bundles | build-time |
| Asset authoring commands | development |
| Pack live parameters and drafts | development |
| Asset/format producers | build-time |
| Shader check | build-time |
| Plugin asset authoring | development |
| Resident Host Pack selection | development |
| Realm dispatch | development |
| ToolContribution | built-in |
| Bound Preview host | built-in |
| Lexical ToolRun terminal | built-in |
| Optional tool service contract | opt-in |
| Project preview | development |
| Engine workspace provider | development |
| Workspace selection outline | development |
| Current-project Editor Play | development |
| Cached asset thumbnails | development |
| Material preview | development |
| Mesh preview | development |
| Texture preview | development |
| VFX preview | development |
| Preview lexical session | development |
| Preview evidence artifacts | development |
| GPU pass timing | development |
| Bounded CPU Profiler | development |
| GPU-driven prepare profiling | development |
| Profile validation/model | development |
| Profile comparison | development |
| Profiler CLI | development |
| Live Engine eval | development |
| Remote introspection | development |
| In-process Remote | development |
| Node WebSocket JSON-RPC | development |
| Browser loopback relay | development |
| Remote full-access boundary | development |
| RHI frame tape | development |
| Deterministic RHI replay | development |
| Per-draw inspect | development |
| RHI debug viewer | development |
| Vite RHI-debug routes | development |
| Immediate-mode Debug Draw | development |
| Screen-to-entity picking | built-in |
| Vertex-level picking | built-in |
| Exact triangle picking | built-in |
| Tile-cell picking | built-in |
| SDK archive build | build-time |
| SDK source mode | build-time |
| SDK ZIP offline bootstrap | build-time |
| SDK npm carrier bootstrap | build-time |
| `game-3d` starter | development |
| SDK agent onboarding | development |
| SDK update discovery | development |
| Verified Candidate / Promotion | build-time |
| Concurrent focused npm publish | build-time |
| Maintenance CLI | development |
