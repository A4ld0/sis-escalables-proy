# Chat en AWS

Aplicación web en Angular y TypeScript con infraestructura en AWS CDK. Cognito gestiona el acceso. La SPA se sirve desde un bucket privado de S3 mediante CloudFront y WAF. API Gateway HTTP y WebSocket ejecutan funciones Lambda. DynamoDB conserva el historial. DynamoDB Streams entrega los mensajes y SQS conserva los fallos agotados y procesa solicitudes de borrado.

## Validar sin crear recursos

Requiere Node.js 22.12+ o 24, npm y una terminal en esta carpeta.

```powershell
npm ci
npm run check
npm test
npm run build
npm run synth
```

La síntesis prepara CloudFormation y empaqueta la SPA y las Lambdas. La prueba local simula un conflicto de escritura entre dos reintentos del mismo mensaje. Para iniciar Angular por separado, `npm start` sirve la SPA, pero el acceso y el chat requieren el `config.json` generado durante el despliegue y servicios disponibles en AWS.

## Desplegar más adelante

Usa una cuenta de pruebas con credenciales de AWS, permiso para crear los recursos y un nombre de entorno único por cuenta. La pila principal usa `us-east-1` para alojar también el WAF de CloudFront. El rol de CloudFormation debe poder resolver los secretos que se configuren.

```powershell
aws sts get-caller-identity --profile mi-perfil
npx cdk bootstrap aws://ID_DE_CUENTA/us-east-1 --profile mi-perfil
npm ci
npm run build
npx cdk diff -c stage=dev --profile mi-perfil
npx cdk deploy -c stage=dev --profile mi-perfil
```

Abre el valor `SiteUrl` de la salida. El sitio obtiene sus URL de API y los parámetros públicos de Cognito de `/config.json`. Conserva el mismo `stage` al actualizar. Si necesitas un prefijo de Cognito distinto, pásalo con `-c domainPrefix=prefijo-unico` desde el primer despliegue. Los recursos retenidos y la protección contra borrado requieren una decisión explícita antes de retirar un entorno.

### Inicio de sesión federado

Configura las aplicaciones en cada proveedor y registra la URL `FederationCallback` de la salida para OAuth. Para el proveedor SAML, registra la salida `SamlAcs` y usa `urn:amazon:cognito:sp:USER_POOL_ID` como identificador del proveedor de servicio. Crea los siguientes secretos JSON en Secrets Manager y pásale al CDK **sus nombres**.

| Contexto CDK | Campos del secreto |
| --- | --- |
| `GoogleSecret` | `client_id`, `client_secret` |
| `FacebookSecret` | `client_id`, `client_secret` |
| `SignInWithAppleSecret` | `client_id`, `team_id`, `key_id`, `private_key` |
| `MicrosoftSecret` | `client_id`, `client_secret`, `oidc_issuer` específico del tenant |
| `CorporateSecret` | `MetadataURL` HTTPS del IdP SAML |

Configura el proveedor para emitir un correo que corresponda al titular. Si el proveedor no emite `email_verified` y verificaste que su política de identidad garantiza el correo, habilita `-c trustFederatedEmail=true` para Facebook, Microsoft o SAML. La aplicación conserva el identificador de Cognito por cuenta y no enlaza automáticamente cuentas locales y federadas por coincidencia de correo.

### Notificaciones

- Web Push. Genera un par VAPID con `npx web-push generate-vapid-keys --json`. Guarda las claves y `subject` (por ejemplo, un contacto `mailto:`) en un secreto JSON. Pasa `-c vapidSecret=nombre-del-secreto -c vapidPublicKey=clave-publica`. Cada usuario habilita las notificaciones desde su perfil en un navegador compatible.
- Correo. Verifica en SES la dirección remitente en `us-east-1`, configura el acceso a producción si lo requiere el entorno y pasa `-c digestFrom=correo-verificado`. Cada usuario puede activar el resumen diario en su perfil.

## Comprobación funcional en AWS

| Requisito | Comprobación |
| --- | --- |
| F1 | Crea dos cuentas, verifica sus correos e inicia sesión. |
| F2 | Completa un inicio de sesión con cada proveedor habilitado. |
| F3 | Cambia nombre, avatar HTTPS y estado y comprueba que los ve la otra cuenta. |
| F4 | Busca por correo y por nombre de usuario. Envía y acepta una invitación. |
| F5–F6 | Abre un chat individual, crea un grupo, añade miembros y un administrador, transfiere la propiedad. Comprueba que se rechaza el miembro 101. |
| F7–F8 | Envía mensajes, abre otra sesión y pagina un historial con más de 50 mensajes. |
| F9–F10 | Comprueba el estado enviado, entregado y leído, el contador y el orden de la bandeja con dos sesiones. |
| F11–F12 | Comprueba presencia e indicador de escritura. Desconecta el navegador, encola un mensaje y vuelve a conectarlo. Abre otra sesión para verificar la recuperación. |
| F13 | Activa Web Push y correo. Cierra las sesiones, recibe un mensaje y verifica el aviso y el resumen. |
| F14 | Bloquea y desbloquea, reporta una conversación, abandona y elimina un grupo. |
| F15 | Exporta los datos, solicita el borrado y verifica en AWS la cola de privacidad, la eliminación en Cognito y la anonimización de los mensajes. |

## Diferencias y validaciones pendientes

- La secuencia, el mensaje y la clave de reintento se guardan en una transacción. Las conexiones se registran en DynamoDB. Agrega `-c redis=true` para habilitar ElastiCache Serverless (Valkey compatible con Redis) para presencia y el límite de eventos de escritura. La opción crea una VPC y dos NAT Gateways para las Lambdas que consultan la caché, con costos recurrentes. Si falla la caché, las Lambdas recurren a DynamoDB. La bandeja usa un índice de DynamoDB actualizado por el fan-out. El orden puede tardar en reflejar un mensaje y la actualización agrega una escritura por destinatario.
- El historial se conserva en DynamoDB para lectura, exportación y anonimización. No se configuró la ruta de archivado con Firehose, S3 y Athena.
- `-c replicaRegion=us-west-2` permite preparar una réplica global de DynamoDB. El resto de la pila se despliega en la región primaria. Falta implementar y ensayar la recuperación regional completa con Route 53 y Cognito.
- CloudWatch define alarmas para latencia de procesamiento del fan-out, atraso del stream y colas de errores. Esa latencia no mide la recepción en el cliente. Los objetivos de disponibilidad, latencia extremo a extremo, escalado, RTO/RPO, WCAG y costo requieren validación adicional. Los reportes se guardan en DynamoDB, sin una consola de moderadores.
- Se usa un ticket desechable para conectar el WebSocket. API Gateway HTTP valida el token de identidad de Cognito al emitirlo. El token no se pone en la URL del socket. Los permisos de las Lambdas están limitados a la tabla de la aplicación, con permisos adicionales por integración, pero aún pueden restringirse por función y patrón de acceso.
- El borrado anonimiza el historial activo y borra la cuenta en segundo plano. El historial de copias de seguridad conserva datos hasta el vencimiento de su retención. Prueba el proceso con el volumen real de datos por usuario y documenta la política de retención antes de ofrecerlo como garantía de cumplimiento.


