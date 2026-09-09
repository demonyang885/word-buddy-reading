# Justin 第一輪姿態識別測試 Protocol

## A. Signal test
- 正常姿態校準 6 秒
- 左歪頭 5 秒 × 2
- 右歪頭 5 秒 × 2
- 左側傾 5 秒 × 2
- 右側傾 5 秒 × 2
- 身體不動只歪頭 × 2
- 頭盡量保持正、身體側傾 × 2

目標：確認 headRoll / shoulderTilt / bodyLean 三組 signal 能否分離。

## B. Writing test
自然完成作業 10–20 分鐘，不刻意要求坐直。

觀察：
- 正常低頭寫字會不會被誤判
- 擦字 / 翻頁 / 看題時是否誤報
- 握筆遮擋視線後，是否伴隨固定方向 headRoll / yawProxy 變化
- 髖部被桌面遮住時 bodyLeanSource 是否大量切到 head-offset

## C. CSV
先看：head_roll_delta_deg、shoulder_tilt_delta_deg、body_lean_delta_deg、distance_ratio、yaw_proxy_delta、pose_confidence、body_lean_source 和四個 alert 欄位。

第一輪目標是找出可重複、可分離的信號，不是追求零誤報。
