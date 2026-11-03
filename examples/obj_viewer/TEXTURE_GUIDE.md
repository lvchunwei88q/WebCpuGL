# NPC_036 角色纹理说明

本文根据仓库中的 PNG 内容、OBJ 部件和当前示例 shader 整理。可以从当前 shader 直接确认的用途会标为“已确认”；仅凭贴图外观推断的用途会标为“推断”。文件名后缀不是通用标准，不能单独作为用途证明。

## 结论速览

| 后缀 | 作用 | 依据 |
|---|---|---|
| `_d` | 漫反射/基础颜色（albedo） | 当前 shader 将 RGB 当作颜色采样 |
| `_m` | 多用途遮罩图；当前示例读取 **G 通道**作为实时卡通阴影遮罩 | shader 明确使用 `mask[1]` |
| `_id` | **很可能是切线空间法线图**；RGB 编码法线方向 | 贴图外观与 RGB 分布符合常见法线图，但当前 shader 未采样，文件后缀本身不能证明 |
| `face_r` | 脸部明暗 ramp / SDF 数据图 | 当前 shader 只读取 R 通道，并按阈值生成脸部明暗 |

PNG 的 alpha 几乎全为 254–255，当前 shader 也将最终 alpha 固定为 1；不要把这些文件当作透明度贴图使用。

## 按部件对应

| OBJ 部件 | 颜色图 | 其他贴图 | 说明 |
|---|---|---|---|
| `裙子.obj` | [`T_NPC_036_01_d.png`](model/texture/T_NPC_036_01_d.png) | [`T_NPC_036_01_id.png`](model/texture/T_NPC_036_01_id.png)、[`T_NPC_036_01_m.png`](model/texture/T_NPC_036_01_m.png) | `_01` 服装/裙装 UV 集 |
| `皮肤.obj` | [`T_NPC_036_02_d.png`](model/texture/T_NPC_036_02_d.png) | [`T_NPC_036_02_id.png`](model/texture/T_NPC_036_02_id.png)、[`T_NPC_036_02_m.png`](model/texture/T_NPC_036_02_m.png) | `_02` 身体皮肤 UV 集 |
| `装饰.obj` | [`T_NPC_036_02_d.png`](model/texture/T_NPC_036_02_d.png) | [`T_NPC_036_02_m.png`](model/texture/T_NPC_036_02_m.png) | 当前示例复用 `_02` 贴图 |
| `眼睛.obj` | [`T_NPC_036_eyes_d.png`](model/texture/T_NPC_036_eyes_d.png) | 无 | 眼睛颜色图；当前示例没有为它绑定独立 mask 或法线图 |
| `脸.obj` | [`T_NPC_036_face_d.png`](model/texture/T_NPC_036_face_d.png) | [`T_NPC_036_face_m.png`](model/texture/T_NPC_036_face_m.png)、[`T_NPC_036_face_r.png`](model/texture/T_NPC_036_face_r.png) | `face_r` 是脸部专用明暗数据，不是普通颜色图 |
| `头发.obj` | [`T_NPC_036_hair_01_d.png`](model/texture/T_NPC_036_hair_01_d.png) | [`T_NPC_036_hair_01_m.png`](model/texture/T_NPC_036_hair_01_m.png) | 第一组头发颜色与遮罩 |
| `头发2.obj` | [`T_NPC_036_hair_02_d.png`](model/texture/T_NPC_036_hair_02_d.png) | [`T_NPC_036_hair_02_m.png`](model/texture/T_NPC_036_hair_02_m.png) | 第二组头发应使用与其颜色图同组的 mask。 |

## 每种贴图的通道

### `_d`：基础颜色图

适用于 `01`、`02`、`eyes`、`face`、`hair_01` 和 `hair_02` 的 `_d.png`。

| 通道 | 当前示例中的作用 |
|---|---|
| R | 颜色红分量 |
| G | 颜色绿分量 |
| B | 颜色蓝分量 |
| A | 未使用；示例输出 alpha 恒为 1 |

当前像素着色器把采样到的 RGB 与光照系数相乘。这里的 `_d` 是角色表面的颜色/花纹，不是阴影、粗糙度或透明度图。

### `_id`：很可能是切线空间法线图（推断）

适用于 [`T_NPC_036_01_id.png`](model/texture/T_NPC_036_01_id.png) 和 [`T_NPC_036_02_id.png`](model/texture/T_NPC_036_02_id.png)。两张图呈蓝紫色/青色的法线图外观，且 B 通道大多接近 255，R/G 有明显变化；这与常见 RGB 切线空间法线图相符。

| 通道 | 常见法线图解释 | 本仓库状态 |
|---|---|---|
| R | 法线 X 分量 | 当前 shader 未读取 |
| G | 法线 Y 分量 | 当前 shader 未读取；Y 方向是否需要翻转不能仅凭 PNG 确定 |
| B | 法线 Z 分量 | 当前 shader 未读取 |
| A | 通常不参与法线解码 | 当前 shader 未读取 |

这是基于图像特征的高概率判断，不是已找到的原游戏材质规范。`_id` 这个后缀也不是“法线图”的通用命名。当前示例仍用 OBJ 的顶点法线照明，因此这两张图目前不会产生凹凸光照效果。

### `_m`：遮罩/打包数据图

适用于 `01_m`、`02_m`、`face_m`、`hair_01_m` 和 `hair_02_m`。

| 通道 | 当前示例中的作用 |
|---|---|
| R | 未读取；具体原始材质含义无法由当前 shader 确认 |
| G | **实时卡通阴影遮罩**。G=1 可接受实时阴影；G=0 保持明亮；中间值按比例混合 |
| B | 未读取；具体原始材质含义无法由当前 shader 确认 |
| A | 未读取；几乎全不透明 |

shader 的计算是 `1 - (1 - band) * mask.g`。所以 G 通道不是“黑白可见性/透明度”：黑色区域会绕过这一步的实时阴影，白色区域会完整接受阴影。虽然 `_m` 的 R/B 中也有数据，但仓库没有原游戏 shader 来确认它们是否代表金属度、粗糙度、发光或其他参数；不要直接按常见 PBR 打包习惯给它们命名。

### `face_r`：脸部明暗 ramp / SDF

[`T_NPC_036_face_r.png`](model/texture/T_NPC_036_face_r.png) 是灰度数据图；文件中 R/G/B 三个通道相同。当前 shader 只采样 **R**，将其与由光照方向计算出的 `ctrl` 比较：`R > ctrl` 时进入阴影，`R < ctrl` 时保持明亮，交界处用窄平滑带抗锯齿。

因此 G、B 在当前实现中只是 R 的重复值；A 未使用。该数据配合脸部 UV/光照方向控制卡通脸部明暗，不应作为普通 RGB 颜色显示。

## 当前示例的实际限制

- 当前绑定关系见 [`main.js`](main.js)，头发阴影逻辑见 [`shaders/hair.sd`](shaders/hair.sd)，脸部逻辑见 [`shaders/face.sd`](shaders/face.sd)。
- shader 只使用 `_d` 的 RGB、`_m` 的 G，以及脸部 `face_r` 的 R；所有 `_id` 图都没有绑定。
- 示例用简化的顶点法线和两档 toon 光照，不是原游戏完整材质。最终画面与原游戏的差异不能单靠这些 PNG 消除。
- 两组头发分别绑定 `hair_01_m` 和 `hair_02_m`，避免第二组头发按第一组的 UV 采样错误遮罩。

## 资料与可信度

没有从公开网页找到可核实的 `T_NPC_036` 原游戏资产说明或官方通道表，因此不能据此确认游戏名称、`_id` 的官方命名含义或 `_m` 未使用通道的用途。以上部件映射和遮罩/ramp 行为以本仓库的 OBJ、[`main.js`](main.js) 与 [`shaders/face.sd`](shaders/face.sd)、[`shaders/body.sd`](shaders/body.sd)、[`shaders/hair.sd`](shaders/hair.sd) 为准；法线图判断仅为贴图特征推断。

以下资料只解释通用法线贴图概念，不代表这些角色文件来自相应引擎：

- [LearnOpenGL: Normal Mapping](https://learnopengl.com/Advanced-Lighting/Normal-Mapping)
- [Unity Manual: Introduction to normal maps](https://docs.unity3d.com/Manual/StandardShaderMaterialParameterNormalMap.html)
