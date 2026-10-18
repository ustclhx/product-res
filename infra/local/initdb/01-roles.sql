-- 集群级账号（只在容器首次初始化时执行）。本地密码与账号名相同，仅用于开发。
--   app      : 业务表 DML，Hyperdrive / 应用运行时使用
--   migrator : DDL，drizzle-kit migrate / push 使用，拥有 public schema 与其中的表
--   readonly : 只读查询
-- 自托管初始化通过 psql 变量传入生产密码；未传入时仍保留本地默认值。
\if :{?app_pw}
\else
  \set app_pw app
\endif
\if :{?migrator_pw}
\else
  \set migrator_pw migrator
\endif
\if :{?readonly_pw}
\else
  \set readonly_pw readonly
\endif
CREATE ROLE app LOGIN PASSWORD :'app_pw';
CREATE ROLE migrator LOGIN PASSWORD :'migrator_pw';
CREATE ROLE readonly LOGIN PASSWORD :'readonly_pw';
